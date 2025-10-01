<!-- Gắn trong <head> để tránh nháy trắng (FOUC) -->
<script>
;(function() {
  try {
    const pref = localStorage.getItem('theme')
    if (pref === 'dark') document.documentElement.classList.add('dark')
    else if (pref === 'light') document.documentElement.classList.add('light')
    // nếu không có pref -> để trình duyệt tự quyết qua prefers-color-scheme
  } catch (_) {}
})();
</script>
