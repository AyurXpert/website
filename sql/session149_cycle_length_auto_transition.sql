-- Session 149: queued cycle-length transition, replacing a "clear and
-- rebuild" fix that turned out not to actually work (nursing_roster_
-- templates has no write RLS at all -- Clear All Slots only empties
-- nursing_roster_template_slots, it never resets the parent template's
-- frozen cycle_length, and there's no RPC to delete/reset the template row
-- itself; "rebuilding" after clearing just kept reusing the stale length).
--
-- Design (Dr. Venkatesh's explicit call, after being shown the broken
-- advice): a hospital roster cannot change structural length mid-cycle --
-- resetting an ACTIVE template the moment MS/Deputy MS approves a cycle
-- change would touch live bed-slot allocations and attendance records
-- currently in effect. Instead, an approved cycle change is a queued intent
-- (nursing_roster_settings.cycle already IS that queue -- Session 138 never
-- touches per-department templates on approval, so this was already true by
-- accident). The one safe moment to actually adopt it per department is
-- right when that department's CURRENT cycle has run out and its Nursing
-- Head deliberately clicks Generate Next Cycle -- so that's where this
-- migration hooks in, not on approval.

CREATE OR REPLACE FUNCTION roll_nursing_roster_template(p_department_id uuid, p_start_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_caller_tenant uuid;
  v_template record;
  v_slot record;
  v_shift_date date;
  v_leave record;
  v_final_profile uuid;
  v_weekly_off smallint;
  v_created int := 0;
  v_gaps jsonb := '[]'::jsonb;
  v_substitutions jsonb := '[]'::jsonb;
  v_holiday_count int := 0;
  v_current_cycle_days int;
  v_cycle_transitioned boolean := false;
  v_old_cycle_days int;
BEGIN
  SELECT tenant_id INTO v_caller_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_caller_tenant IS NULL THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF NOT public._nursing_roster_editor_ok(auth.uid(), v_caller_tenant) THEN
    RAISE EXCEPTION 'Only the current Nursing Head, Medical Director/Principal/Medical Superintendent, or super_admin can roll the roster forward';
  END IF;

  SELECT * INTO v_template FROM public.nursing_roster_templates
  WHERE tenant_id = v_caller_tenant AND department_id = p_department_id;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'No roster template configured for this department yet';
  END IF;

  -- Auto-adopt the tenant's currently-approved cycle length, right now,
  -- since we're already about to generate a brand new cycle from scratch --
  -- the exact "current cycle just ended" moment this is meant to happen.
  -- Existing slots are left completely untouched: a GROWING cycle keeps
  -- every existing day_offset valid as-is (0..6 all still fit inside
  -- 0..13); a SHRINKING cycle just means slots at a now-out-of-range
  -- day_offset are quietly skipped in the loop below (an honest gap the
  -- head can re-staff, matching this feature's existing gap philosophy --
  -- never silently deleted).
  SELECT CASE cycle WHEN 'weekly' THEN 7 WHEN 'fortnightly' THEN 14 WHEN 'monthly' THEN 30 END
    INTO v_current_cycle_days
    FROM public.nursing_roster_settings WHERE tenant_id = v_caller_tenant;
  v_current_cycle_days := COALESCE(v_current_cycle_days, 7);

  v_old_cycle_days := v_template.cycle_length;
  IF v_current_cycle_days != v_old_cycle_days THEN
    UPDATE public.nursing_roster_templates SET cycle_length = v_current_cycle_days, updated_at = now()
    WHERE id = v_template.id;
    v_template.cycle_length := v_current_cycle_days;
    v_cycle_transitioned := true;
  END IF;

  FOR v_slot IN
    SELECT * FROM public.nursing_roster_template_slots
    WHERE template_id = v_template.id AND day_offset < v_template.cycle_length
  LOOP
    v_shift_date := p_start_date + v_slot.day_offset;
    v_final_profile := v_slot.profile_id;

    SELECT * INTO v_leave FROM public.staff_leaves
    WHERE profile_id = v_slot.profile_id AND status = 'approved'
      AND from_date <= v_shift_date AND to_date >= v_shift_date
    LIMIT 1;

    IF FOUND THEN
      IF v_leave.covering_profile_id IS NOT NULL THEN
        v_final_profile := v_leave.covering_profile_id;
        v_substitutions := v_substitutions || jsonb_build_object(
          'date', v_shift_date, 'shift_type', v_slot.shift_type,
          'original_profile_id', v_slot.profile_id, 'covering_profile_id', v_leave.covering_profile_id
        );
      ELSE
        v_gaps := v_gaps || jsonb_build_object(
          'date', v_shift_date, 'shift_type', v_slot.shift_type, 'profile_id', v_slot.profile_id,
          'reason', 'on approved leave, no covering staff assigned'
        );
        CONTINUE;
      END IF;
    END IF;

    SELECT weekly_off_day INTO v_weekly_off FROM public.profiles WHERE id = v_final_profile;
    IF v_weekly_off IS NOT NULL AND v_weekly_off = EXTRACT(DOW FROM v_shift_date)::smallint THEN
      v_gaps := v_gaps || jsonb_build_object(
        'date', v_shift_date, 'shift_type', v_slot.shift_type, 'profile_id', v_final_profile,
        'reason', 'weekly off, no relief nurse assigned'
      );
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.public_holidays WHERE tenant_id = v_caller_tenant AND holiday_date = v_shift_date) THEN
      v_holiday_count := v_holiday_count + 1;
    END IF;

    INSERT INTO public.duty_roster
      (tenant_id, department_id, profile_id, shift_date, shift_type, slot_index, bed_range_start, bed_range_end, created_by)
    VALUES
      (v_caller_tenant, p_department_id, v_final_profile, v_shift_date, v_slot.shift_type, v_slot.slot_index,
       v_slot.bed_range_start, v_slot.bed_range_end, auth.uid())
    ON CONFLICT (tenant_id, department_id, shift_date, shift_type, slot_index) DO UPDATE SET
      profile_id = excluded.profile_id, bed_range_start = excluded.bed_range_start, bed_range_end = excluded.bed_range_end;

    v_created := v_created + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'created', v_created, 'gaps', v_gaps, 'substitutions', v_substitutions, 'holiday_count', v_holiday_count,
    'cycle_transitioned', v_cycle_transitioned, 'old_cycle_days', v_old_cycle_days, 'new_cycle_days', v_current_cycle_days
  );
END;
$$;
GRANT EXECUTE ON FUNCTION roll_nursing_roster_template(uuid, date) TO authenticated;
