// static/js/order.js
(() => {
  const settings = window.BTS_ORDER_PAGE || {};

  const normalizeOptionValue = (value) => {
    if (value && typeof value === 'object') {
      return value.value ?? value.count ?? 1;
    }
    return value;
  };

  const allowedSchedules = Array.isArray(settings.scheduleOptions)
    ? settings.scheduleOptions.map(normalizeOptionValue).map(String)
    : [];

  document.addEventListener('DOMContentLoaded', () => {
    const scheduleSelect = document.getElementById('paySchedule');
    if (scheduleSelect && allowedSchedules.length) {
      const keep = new Set(allowedSchedules);
      const options = Array.from(scheduleSelect.options);
      options.forEach((opt) => {
        if (!keep.has(opt.value)) {
          scheduleSelect.removeChild(opt);
        }
      });
      if (scheduleSelect.options.length <= 1) {
        scheduleSelect.selectedIndex = 0;
        scheduleSelect.classList.add('only-option');
        scheduleSelect.disabled = settings.lockSingleSchedule === true;
      }
    }

    if (settings.focusField) {
      const node = document.getElementById(settings.focusField);
      if (node && typeof node.focus === 'function') {
        setTimeout(() => node.focus(), 0);
      }
    }

    if (settings.bodyClass) {
      document.body.classList.add(settings.bodyClass);
    }
  });
})();
