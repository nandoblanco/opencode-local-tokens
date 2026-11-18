import { createRenderer } from "solid-js/universal";
export { createComponent } from "solid-js";

const renderer = createRenderer({
  createElement(tag: string) {
    const node = document.createElement("div");
    node.dataset.kind = tag;
    Object.assign(node.style, tag === "box" ? { display: "flex", flexShrink: "0" } : { whiteSpace: "pre-wrap" });
    return node;
  },
  createTextNode: (text: string) => document.createTextNode(text),
  replaceText: (node: Text, text: string) => { node.data = text; },
  setProperty(node: HTMLElement, name: string, value: any) {
    if (name === "fg") node.style.color = value;
    else if (name === "border") node.style.border = value ? "1px solid" : "none";
    else if (name === "wrapMode") node.style.whiteSpace = value === "none" ? "pre" : "pre-wrap";
    else if (name === "truncate" && value) { node.style.overflow = "hidden"; node.style.textOverflow = "ellipsis"; }
    else if (name.startsWith("on")) node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name.startsWith("padding") || name === "gap") node.style[name as any] = `${value * 8}px`;
    else if (["minWidth", "width", "flexBasis"].includes(name)) node.style[name as any] = typeof value === "number" ? `${value}px` : value;
    else node.style[name as any] = String(value);
  },
  insertNode: (parent: Node, node: Node, anchor?: Node) => parent.insertBefore(node, anchor || null),
  isTextNode: (node: Node) => node.nodeType === 3,
  removeNode: (parent: Node, node: Node) => parent.removeChild(node),
  getParentNode: (node: Node) => node.parentNode,
  getFirstChild: (node: Node) => node.firstChild,
  getNextSibling: (node: Node) => node.nextSibling,
});
export const { createElement, createTextNode, insertNode, setProp, effect, render } = renderer;
export function insert(parent: Node, value: any) {
  const anchor = document.createTextNode("");
  parent.appendChild(anchor);
  renderer.insert(parent, value, anchor);
}
export function use(callback: (node: Node) => void, node: Node) { callback(node); }
