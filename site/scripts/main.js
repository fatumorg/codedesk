// Navigation hamburger toggle
(function() {
  const nav = document.getElementById('nav');
  const hamburger = nav.querySelector('.hamburger');
  const navLinks = nav.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function() {
      nav.classList.toggle('nav-open');
      const isOpen = nav.classList.contains('nav-open');
      hamburger.setAttribute('aria-expanded', isOpen);
    });

    // Close menu on link click
    navLinks.querySelectorAll('a').forEach(function(link) {
      link.addEventListener('click', function() {
        nav.classList.remove('nav-open');
      });
    });

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
        nav.classList.remove('nav-open');
        hamburger.focus();
      }
    });
  }
})();
