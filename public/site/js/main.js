// Mobile navigation.
const menuToggle = document.getElementById('menuToggle');
const navLinks = document.getElementById('navLinks');
menuToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
navLinks?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => navLinks.classList.remove('open')));

// Live AI status (shown only when the server runs in demo mode). Reports which key and model answered, never the keys.
(async () => {
  const el = document.getElementById('aiStatus');
  if (!el) return;
  try {
    const res = await fetch('/api/ai-status');
    if (!res.ok) return;
    const s = await res.json();
    el.hidden = false;
    el.textContent = s.live
      ? `● Live demo: Gemini answering (${s.served_by})`
      : (s.keys_configured
          ? '● Live demo: Gemini not reachable right now. Rule-based answers are shown.'
          : '● Live demo: running on rule-based answers (no AI keys configured).');
    el.classList.add(s.live ? 'live' : 'offline');
  } catch {
    // Offline or not in demo mode: stay quiet.
  }
})();

// Scroll reveal for elements marked .reveal (staggered by the --i custom property).
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add('in'));
}
