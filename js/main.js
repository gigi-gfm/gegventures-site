// Gegventures site — lightweight interactivity

(function () {
  // Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") nav.classList.remove("is-open");
    });
  }

  // Contact form — front-end only confirmation (no backend wired up)
  var form = document.querySelector("[data-contact-form]");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = form.querySelector("[data-form-status]");
      if (status) {
        status.textContent =
          "Thanks — your request has been captured. A Gegventures strategist will reach out within one business day.";
        status.hidden = false;
      }
      form.reset();
    });
  }

  // Current year in footer
  var yearEls = document.querySelectorAll("[data-year]");
  yearEls.forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });
})();
