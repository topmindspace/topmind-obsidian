// Minimal Obsidian host for tests that render the shipped settings tab.
// The published `obsidian` package is types only. This stub implements the
// Setting surface the settings module actually calls. It does not reimplement
// plugin settings logic.

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.attrs = {};
    this._listeners = {};
    this.textContent = "";
    this.text = "";
    this._value = "";
    this.disabled = false;
    this.placeholder = "";
    this.id = "";
    this.style = {};
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = v == null ? "" : String(v);
  }

  get type() {
    return this.attrs.type || "";
  }

  set type(v) {
    this.attrs.type = v == null ? "" : String(v);
  }

  get options() {
    return this.children.filter((child) => child.tagName === "OPTION");
  }

  get files() {
    return this._files || { length: 0, item: () => null };
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === "type") this.attrs.type = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    if (name === "type") return this.type;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  addClass(cls) {
    const next = new Set(this.className.split(/\s+/u).filter(Boolean));
    for (const part of String(cls).split(/\s+/u)) if (part) next.add(part);
    this.className = [...next].join(" ");
  }

  removeClass(cls) {
    const drop = new Set(String(cls).split(/\s+/u));
    this.className = this.className.split(/\s+/u).filter((part) => part && !drop.has(part)).join(" ");
  }

  addEventListener(type, fn) {
    const list = this._listeners[type] || [];
    list.push(fn);
    this._listeners[type] = list;
  }

  dispatchEvent(event) {
    const type = event && event.type;
    for (const fn of this._listeners[type] || []) fn(event);
    return true;
  }

  empty() {
    this.children = [];
  }

  createEl(tag, opts = {}) {
    const el = new El(tag);
    if (opts.cls) el.addClass(opts.cls);
    if (opts.text != null) {
      el.textContent = String(opts.text);
      el.text = el.textContent;
    }
    if (opts.value != null) el.value = String(opts.value);
    if (opts.attr) {
      for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
    }
    this.appendChild(el);
    return el;
  }

  createSpan(opts) {
    return this.createEl("span", opts);
  }

  createDiv(opts) {
    return this.createEl("div", opts);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      if (matches(node, selector)) out.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }
}

function matches(el, selector) {
  const match = String(selector).match(/^([a-z0-9]+)(?:\[([a-z0-9-]+)="([^"]*)"\])?$/iu);
  if (!match) return false;
  if (el.tagName !== match[1].toUpperCase()) return false;
  if (!match[2]) return true;
  return el.getAttribute(match[2]) === match[3];
}

function createElement(tag) {
  return new El(tag);
}

const documentStub = {
  createElement,
  body: new El("body"),
};

if (typeof globalThis.document === "undefined") globalThis.document = documentStub;
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.window.setTimeout !== "function") globalThis.window.setTimeout = setTimeout;
if (typeof globalThis.window.clearTimeout !== "function") globalThis.window.clearTimeout = clearTimeout;

class DropdownComponent {
  constructor(parent) {
    this.selectEl = createElement("select");
    parent.appendChild(this.selectEl);
  }

  addOption(value, label) {
    const option = createElement("option");
    option.value = value;
    option.textContent = label == null ? "" : String(label);
    option.text = option.textContent;
    this.selectEl.appendChild(option);
    return this;
  }

  setValue(value) {
    this.selectEl.value = value == null ? "" : String(value);
    return this;
  }

  onChange(fn) {
    this.selectEl.addEventListener("change", () => {
      fn(this.selectEl.value);
    });
    return this;
  }
}

class TextComponent {
  constructor(parent) {
    this.inputEl = createElement("input");
    this.inputEl.type = "text";
    parent.appendChild(this.inputEl);
  }

  setValue(value) {
    this.inputEl.value = value == null ? "" : String(value);
    return this;
  }

  setPlaceholder(value) {
    this.inputEl.placeholder = value == null ? "" : String(value);
    return this;
  }

  setDisabled(disabled) {
    this.inputEl.disabled = Boolean(disabled);
    return this;
  }

  onChange(fn) {
    this.inputEl.addEventListener("input", () => {
      fn(this.inputEl.value);
    });
    return this;
  }
}

class ButtonComponent {
  constructor(parent) {
    this.buttonEl = createElement("button");
    parent.appendChild(this.buttonEl);
  }

  setButtonText(text) {
    this.buttonEl.textContent = text == null ? "" : String(text);
    return this;
  }

  setDisabled(disabled) {
    this.buttonEl.disabled = Boolean(disabled);
    return this;
  }

  setDestructive() {
    this.buttonEl.addClass("mod-warning");
    return this;
  }

  onClick(fn) {
    this.buttonEl.addEventListener("click", () => {
      fn();
    });
    return this;
  }
}

class ExtraButtonComponent {
  constructor(parent) {
    this.extraSettingsEl = createElement("button");
    parent.appendChild(this.extraSettingsEl);
  }

  setIcon() {
    return this;
  }

  setTooltip() {
    return this;
  }

  setDisabled() {
    return this;
  }

  onClick(fn) {
    this.extraSettingsEl.addEventListener("click", () => {
      fn();
    });
    return this;
  }
}

export class Setting {
  constructor(containerEl) {
    this.settingEl = createElement("div");
    this.settingEl.addClass("setting-item");
    this.infoEl = createElement("div");
    this.controlEl = createElement("div");
    this.nameEl = createElement("div");
    this.descEl = createElement("div");
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }

  setName(name) {
    this.nameEl.textContent = name == null ? "" : String(name);
    return this;
  }

  setDesc(desc) {
    this.descEl.textContent = desc == null ? "" : String(desc);
    return this;
  }

  addDropdown(cb) {
    const dropdown = new DropdownComponent(this.controlEl);
    cb(dropdown);
    return this;
  }

  addText(cb) {
    const text = new TextComponent(this.controlEl);
    cb(text);
    return this;
  }

  addButton(cb) {
    const button = new ButtonComponent(this.controlEl);
    cb(button);
    return this;
  }

  addExtraButton(cb) {
    const button = new ExtraButtonComponent(this.controlEl);
    cb(button);
    return this;
  }

  then(cb) {
    cb(this);
    return this;
  }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createElement("div");
  }

  update() {}

  hide() {}
}

export class Notice {
  constructor(message) {
    this.message = message == null ? "" : String(message);
  }
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = createElement("div");
  }

  open() {}

  close() {}

  onOpen() {}

  onClose() {}
}

export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = createElement("div");
    this.contentEl = createElement("div");
  }
}

export class WorkspaceLeaf {}
export class Component {
  load() {}
  unload() {}
  addChild() {}
}
export class Menu {}
export class TFile {}
export class Plugin {}

export const MarkdownRenderer = {
  render() {
    return Promise.resolve();
  },
};

export function setIcon() {}

export function getLanguage() {
  return "en";
}

export function requestUrl() {
  return Promise.reject(new Error("obsidian host stub: no network"));
}

export { createElement, documentStub as document };
