import { wireDelegatedEvents } from '../utils/domEvents.js';

const btn = document.getElementById('nav-hamburger');
const mob = document.getElementById('nav-mobile');
btn.addEventListener('click', () => {
  btn.classList.toggle('open');
  mob.classList.toggle('open');
});

window.closeMobile = function() {
  btn.classList.remove('open');
  mob.classList.remove('open');
};

document.addEventListener('click', e => { if (!e.target.closest('.nav')) window.closeMobile(); });

wireDelegatedEvents();
