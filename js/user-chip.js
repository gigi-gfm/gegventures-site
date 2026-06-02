// Drops a "Signed in as Name | Sign out" chip into the nav, and shows the
// admin-only "Users" link when applicable.
(function () {
  var chip = document.getElementById('userChip');
  var nameEl = document.getElementById('userName');
  var logout = document.getElementById('logoutLink');
  var usersLink = document.getElementById('usersLink');

  fetch('/api/auth/me')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var u = data && data.user;
      if (!u) {
        if (window.location.pathname !== '/login.html') {
          window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
        }
        return;
      }
      if (chip && nameEl) {
        nameEl.textContent = u.name;
        chip.hidden = false;
      }
      if (usersLink && u.role === 'admin') usersLink.hidden = false;
    })
    .catch(function () { /* ignore */ });

  if (logout) {
    logout.addEventListener('click', function (e) {
      e.preventDefault();
      fetch('/api/auth/logout', { method: 'POST' }).then(function () {
        window.location.href = '/login.html';
      });
    });
  }
})();
