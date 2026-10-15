/**
 * Shared admin-page behaviour.
 *
 * This app's Content-Security-Policy is `script-src 'self'` with no
 * 'unsafe-inline' (and helmet's default `script-src-attr 'none'`), so every
 * inline onclick/onsubmit handler was silently dead in a compliant browser --
 * including the confirmations guarding Delete Motion, Revoke Token and Email
 * Results, which therefore fired with no prompt at all.
 *
 * Behaviour is declared with data attributes and attached here instead.
 */
(function () {
  'use strict';

  function init() {
    // Confirmation dialogs: <form data-confirm="..."> or <a data-confirm="...">
    document.querySelectorAll('[data-confirm]').forEach(function (el) {
      var message = el.getAttribute('data-confirm');
      if (!message) return;

      if (el.tagName === 'FORM') {
        el.addEventListener('submit', function (e) {
          if (!window.confirm(message)) {
            e.preventDefault();
          }
        });
      } else {
        el.addEventListener('click', function (e) {
          if (!window.confirm(message)) {
            e.preventDefault();
          }
        });
      }
    });

    // Read-only voting-link fields: clicking selects the whole value so it can
    // be copied with one keystroke.
    document.querySelectorAll('.js-select-on-click').forEach(function (input) {
      input.addEventListener('click', function () {
        this.select();
      });
      // Also select on focus so keyboard users get the same behaviour.
      input.addEventListener('focus', function () {
        this.select();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
