// Safe mini-markdown renderer: builds DOM nodes (never innerHTML), links open in a new tab.
(function () {
  const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g;

  function link(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) {
        const b = document.createElement("strong");
        b.textContent = m[1];
        parent.append(b);
      } else if (m[2] !== undefined) {
        const c = document.createElement("code");
        c.textContent = m[2];
        parent.append(c);
      } else if (m[3] !== undefined) {
        parent.append(link(m[4], m[3]));
      } else {
        let url = m[5];
        const trail = url.match(/[.,;:!?)\]]+$/);
        if (trail) url = url.slice(0, -trail[0].length);
        parent.append(link(url, url));
        if (trail) parent.append(trail[0]);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function lines(parent, arr) {
    arr.forEach((l, i) => {
      if (i) parent.append(document.createElement("br"));
      inline(parent, l);
    });
  }

  window.renderRich = function (text) {
    const root = document.createElement("div");
    root.className = "rich";
    const blocks = text.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
    for (const block of blocks) {
      const ls = block.split("\n");
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
      if (ls.every((l) => bullet.test(l))) {
        const ordered = /^\s*\d+[.)]/.test(ls[0]);
        const list = document.createElement(ordered ? "ol" : "ul");
        for (const l of ls) {
          const li = document.createElement("li");
          inline(li, l.replace(bullet, ""));
          list.append(li);
        }
        root.append(list);
      } else {
        const p = document.createElement("p");
        lines(p, ls);
        root.append(p);
      }
    }
    return root;
  };
})();
