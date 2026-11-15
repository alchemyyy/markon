import { createElement, createEventHandler } from "./utils.js";

const ensureId = (h, idx) => {
  if (!h.id) {
    h.id = `h-${idx}-${h.textContent
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")}`;
  }
  return h;
};

const extractHeaders = (previewHtml) =>
  Array.from(previewHtml.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map(ensureId)
    .map((h) => ({
      id: h.id,
      text: h.textContent.trim(),
      level: parseInt(h.tagName[1]),
      element: h,
    }))
    .filter((h) => h.text);

const findHeaderInMarkdown = (markdown, header) => {
  const prefix = "#".repeat(header.level) + " ";
  const escapedText = header.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${prefix}${escapedText}\\s*(?:\\{#.*\\})?$`, "m");
  const match = markdown.match(pattern);
  return match ? markdown.substring(0, match.index).split("\n").length : null;
};

const scrollToHeader = (header, getMarkdown, scrollToLine) => {
  if (!header?.element) return;
  header.element.scrollIntoView({ behavior: "smooth", block: "start" });
  if (getMarkdown && scrollToLine) {
    const markdown = getMarkdown();
    const lineNumber = findHeaderInMarkdown(markdown, header);
    if (lineNumber) scrollToLine(lineNumber);
  }
};

const createTOCItem = (header, onScroll) => {
  const item = createElement(
    "div",
    {
      className: "toc-item",
      textContent: header.text,
      style: { paddingLeft: `${(header.level - 1) * 10}px` },
    },
    [],
  );
  item.setAttribute("data-level", header.level);
  createEventHandler(item, "click", () => onScroll(header));
  return item;
};

const createTOCList = (headers, onScroll) =>
  headers.length
    ? headers.map((h) => createTOCItem(h, onScroll))
    : [
        createElement(
          "div",
          { className: "toc-empty", textContent: "No headers" },
          [],
        ),
      ];

const updateTOCList = (dropdown, headers, onScroll) => {
  dropdown.innerHTML = "";
  createTOCList(headers, onScroll).forEach((item) =>
    dropdown.appendChild(item),
  );
};

const createHoverHandlers = (button, dropdown, delay = 300) => {
  let hideTimer;
  let isOpen = false;

  const show = () => {
    clearTimeout(hideTimer);
    isOpen = true;
    dropdown.style.opacity = "1";
    dropdown.style.pointerEvents = "auto";
  };

  const hide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      isOpen = false;
      dropdown.style.opacity = "0";
      dropdown.style.pointerEvents = "none";
    }, delay);
  };

  const toggle = () => {
    if (isOpen) {
      clearTimeout(hideTimer);
      isOpen = false;
      dropdown.style.opacity = "0";
      dropdown.style.pointerEvents = "none";
    } else {
      show();
    }
  };

  createEventHandler(button, "mouseenter", show);
  createEventHandler(dropdown, "mouseenter", show);
  createEventHandler(button, "mouseleave", hide);
  createEventHandler(dropdown, "mouseleave", hide);
  createEventHandler(button, "click", toggle);
};

// Observes each renderer's content root once it exists; returns the function that adds one
const observePreview = (update) => {
  const observer = new MutationObserver(() => {
    requestAnimationFrame(update);
  });
  const observed = new Set();
  return (root) => {
    if (!root || observed.has(root)) return;
    observed.add(root);
    observer.observe(root, { childList: true, subtree: true });
  };
};

export const createTOC = (preview, previewContainer, { getMarkdown, scrollToLine } = {}) => {
  const button = createElement(
    "iconify-icon",
    {
      id: "toc-button",
      icon: "tabler:list",
      width: "24",
      height: "24",
    },
    [],
  );

  const dropdown = createElement("div", { id: "toc-dropdown" }, []);
  const wrapper = createElement("div", { id: "toc-wrapper" }, [
    dropdown,
    button,
  ]);

  previewContainer.appendChild(wrapper);
  createHoverHandlers(button, dropdown);

  const onScroll = (header) => scrollToHeader(header, getMarkdown, scrollToLine);

  const update = () => {
    const root = preview.contentRoot();
    updateTOCList(dropdown, root ? extractHeaders(root) : [], onScroll);
  };

  // Follows whichever renderer the preview shows
  const observe = observePreview(update);
  const follow = () => {
    observe(preview.contentRoot());
    update();
  };
  follow();
  preview.onChange(follow);
};
