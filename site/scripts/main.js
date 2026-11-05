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

    navLinks.querySelectorAll('a').forEach(function(link) {
      link.addEventListener('click', function() {
        nav.classList.remove('nav-open');
      });
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
        nav.classList.remove('nav-open');
        hamburger.focus();
      }
    });
  }
})();

// Hero section animation
(function() {
  var hero = document.getElementById('hero');
  if (!hero) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reducedMotion) {
    // Show everything immediately
    hero.querySelectorAll('.hero-workspace, .hero-conversation').forEach(function(el) {
      el.classList.add('visible');
    });
    hero.querySelectorAll('.show-early').forEach(function(el) {
      el.classList.add('show-early');
    });
    return;
  }

  // Animate cards in
  var workspace = hero.querySelector('.hero-workspace');
  var conversation = hero.querySelector('.hero-conversation');
  var linePath = hero.querySelector('.line-path');
  var lineDot = hero.querySelector('.line-dot');

  // Step 1: slide workspace card in
  requestAnimationFrame(function() {
    if (workspace) workspace.classList.add('visible');
  });

  // Step 2: slide conversation window in
  setTimeout(function() {
    if (conversation) conversation.classList.add('visible');
  }, 200);

  // Step 3: draw connecting line
  setTimeout(function() {
    if (linePath) linePath.classList.add('drawn');
    if (lineDot) lineDot.classList.add('drawn');
  }, 700);

  // Step 4: animate conversation elements in sequence
  setTimeout(function() {
    var msgs = conversation.querySelectorAll('.message');
    msgs.forEach(function(msg, i) {
      var text = msg.querySelector('.msg-text');
      if (text && !text.classList.contains('show-early')) {
        setTimeout(function() {
          text.style.animation = 'fadeInUp 0.3s ease forwards';
          text.style.opacity = '0';
          text.style.transform = 'translateY(8px)';
          requestAnimationFrame(function() {
            text.style.opacity = '1';
            text.style.transform = 'none';
            text.style.transition = 'opacity 0.3s, transform 0.3s';
          });
        }, i * 200);
      }
    });

    // Code block
    var codeBlocks = conversation.querySelectorAll('.code-block');
    codeBlocks.forEach(function(cb, i) {
      setTimeout(function() {
        cb.style.animation = 'fadeInUp 0.3s ease forwards';
        cb.style.opacity = '0';
        requestAnimationFrame(function() {
          cb.style.opacity = '1';
          cb.style.transition = 'opacity 0.3s';
        });
      }, 1500 + i * 200);
    });

    // Diff block
    setTimeout(function() {
      var diff = conversation.querySelector('.diff-block');
      if (diff) {
        diff.style.animation = 'fadeInUp 0.3s ease forwards';
        diff.style.opacity = '0';
        requestAnimationFrame(function() {
          diff.style.opacity = '1';
          diff.style.transition = 'opacity 0.3s';
        });
      }
    }, 2000);

    // Permission prompt
    setTimeout(function() {
      var prompt = conversation.querySelector('.prompt-approval');
      if (prompt) {
        prompt.style.animation = 'fadeInUp 0.4s ease forwards';
        prompt.style.opacity = '0';
        requestAnimationFrame(function() {
          prompt.style.opacity = '1';
          prompt.style.transition = 'opacity 0.4s';
        });
      }
    }, 2200);
  }, 800);

  // Mouse-reactive effects (desktop only)
  var isPointerFine = window.matchMedia('(pointer: fine)').matches;
  var glow = hero.querySelector('.cursor-glow');

  if (isPointerFine && glow) {
    document.addEventListener('mousemove', throttle(function(e) {
      glow.style.left = e.clientX + 'px';
      glow.style.top = e.clientY + 'px';
      glow.style.opacity = '1';
    }, 50));
  }

  // Subtle parallax on cards
  var cards = hero.querySelectorAll('.hero-workspace, .hero-conversation');
  if (isPointerFine && cards.length) {
    document.addEventListener('mousemove', throttle(function(e) {
      var cx = window.innerWidth / 2;
      var cy = window.innerHeight / 2;
      var dx = (e.clientX - cx) / cx;
      var dy = (e.clientY - cy) / cy;

      cards.forEach(function(card) {
        var speed = card.classList.contains('hero-workspace') ? 3 : -3;
        card.style.transform = 'translate(' + (dx * speed) + 'px,' + (dy * speed) + 'px)';
      });
    }, 50));
  }

  // Cleanup on mouse leave
  document.addEventListener('mouseleave', function() {
    if (glow) glow.style.opacity = '0';
  });

  function throttle(fn, ms) {
    var last = 0;
    return function() {
      var now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn.apply(this, arguments);
      }
    };
  }
})();

// Scroll-triggered reveal animations
(function() {
  var reveals = document.querySelectorAll('.reveal');
  if (!reveals.length) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reducedMotion) {
    // Show all reveals immediately
    reveals.forEach(function(el) { el.classList.add('visible'); });
    return;
  }

  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });

  reveals.forEach(function(el) { observer.observe(el); });
})();

// Effort slider
(function() {
  var slider = document.getElementById('effort-slider');
  var badge = document.getElementById('model-badge');
  if (!slider || !badge) return;

  var levels = ['Low', 'Medium', 'High', 'Max', 'Ultracode'];

  function updateBadge() {
    var idx = parseInt(slider.value, 10);
    badge.textContent = levels[idx] || levels[0];
  }

  slider.addEventListener('input', updateBadge);
  updateBadge();
})();

// Accent swatches
(function() {
  var swatches = document.querySelectorAll('.swatch');
  if (!swatches.length) return;

  var root = document.documentElement;

  swatches.forEach(function(sw) {
    sw.addEventListener('click', function() {
      swatches.forEach(function(s) { s.setAttribute('aria-checked', 'false'); });
      sw.setAttribute('aria-checked', 'true');
      root.style.setProperty('--accent', sw.dataset.color);
      root.style.setProperty('--accent-soft', sw.dataset.color + '2e');
    });
  });
})();

// Screenshot gallery overlay
(function() {
  var screens = document.querySelectorAll('.screenshot');
  if (!screens.length) return;

  var overlay = document.createElement('div');
  overlay.className = 'gallery-overlay';
  overlay.innerHTML = '<div class="overlay-close" aria-label="Close">&times;</div><div class="overlay-content"></div>';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(31,30,28,0.92);z-index:9999;display:none;align-items:center;justify-content:center;flex-direction:column;padding:24px;';
  overlay.querySelector('.overlay-content').style.cssText = 'max-width:90vw;max-height:80vh;border-radius:8px;border:1px solid rgba(243,239,230,0.15);display:flex;align-items:center;justify-content:center;background:#282622;';
  overlay.querySelector('.overlay-close').style.cssText = 'position:absolute;top:16px;right:20px;font-size:28px;color:#f3efe6;cursor:pointer;';

  document.body.appendChild(overlay);

  screens.forEach(function(s) {
    s.addEventListener('click', function() {
      var text = s.querySelector('.screenshot-placeholder').textContent;
      overlay.querySelector('.overlay-content').textContent = text;
      overlay.style.display = 'flex';
    });
    s.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        s.click();
      }
    });
  });

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay || e.target.classList.contains('overlay-close')) {
      overlay.style.display = 'none';
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') overlay.style.display = 'none';
  });
})();
