((root) => {
  "use strict";

  function controlText(control) {
    if (!control) return "";
    if (typeof control.value === "string") return control.value;
    return typeof control.textContent === "string" ? control.textContent : "";
  }

  function selectControl(control, text) {
    if (!control) return false;
    try {
      try {
        control.focus({ preventScroll: true });
      } catch {
        control.focus();
      }
      if (typeof control.setSelectionRange === "function") {
        control.setSelectionRange(0, text.length);
      } else if (typeof control.select === "function") {
        control.select();
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function temporaryControl(documentObject, text) {
    if (!documentObject || typeof documentObject.createElement !== "function") return null;
    const area = documentObject.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.inset = "0 auto auto -10000px";
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.fontSize = "16px";
    const parent = documentObject.querySelector?.("dialog[open]") || documentObject.body;
    if (!parent || typeof parent.append !== "function") return null;
    parent.append(area);
    return area;
  }

  async function copyText(options = {}) {
    const documentObject = options.documentObject || root.document;
    const navigatorObject = options.navigatorObject || root.navigator;
    const secureContext = options.secureContext ?? root.isSecureContext;
    const suppliedControl = options.control || null;
    const text = String(options.text ?? controlText(suppliedControl));
    if (!text) return { copied: false, selected: false, method: "empty" };

    if (secureContext && typeof navigatorObject?.clipboard?.writeText === "function") {
      try {
        await navigatorObject.clipboard.writeText(text);
        return { copied: true, selected: false, method: "clipboard" };
      } catch {
        // Continue with a selection-based fallback for restricted browsers.
      }
    }

    const control = suppliedControl || temporaryControl(documentObject, text);
    const temporary = control !== suppliedControl;
    const selected = selectControl(control, text);
    let copied = false;
    if (selected && typeof documentObject?.execCommand === "function") {
      try {
        copied = documentObject.execCommand("copy") === true;
      } catch {
        copied = false;
      }
    }
    if (temporary) control?.remove?.();
    return { copied, selected: selected && !temporary, method: copied ? "legacy" : "manual" };
  }

  root.PebbleClipboard = Object.freeze({ copyText, controlText });
})(globalThis);
