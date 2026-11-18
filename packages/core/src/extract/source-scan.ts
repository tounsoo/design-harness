import type * as t from "@babel/types";
import type { ElementNode, PropValue } from "./model";
import type { Evaluator } from "./evaluator";
import { boundNames, childNodes, locationOf, originOf } from "./modules";
import { cleanJsxText } from "./evaluator";
import { Env, unknown, type Value } from "./values";

/**
 * Every JSX element written in a module, nested as the source nests it, with
 * tags resolved in their lexical scope but local components left unexpanded.
 * Rules that hold for the source as written (no raw controls, no inline
 * styles) read this, and so does the check that every element a per-page
 * rule counts is reached from some page.
 */
export function scanSource(evaluator: Evaluator, env: Env, root: t.Node): ElementNode[] {
  return walk(root, env);

  function walk(node: t.Node, scope: Env): ElementNode[] {
    switch (node.type) {
      case "JSXElement":
        return element(node, scope);
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ObjectMethod":
      case "ClassMethod": {
        const inner = new Env(scope.module, scope);
        for (const param of node.params) for (const name of boundNames(param)) inner.set(name, unknown("a parameter"));
        if (node.body.type === "BlockStatement") evaluator.hoist(node.body.body, inner);
        return childNodes(node).flatMap((child) => walk(child, inner));
      }
      case "BlockStatement": {
        const inner = new Env(scope.module, scope);
        evaluator.hoist(node.body, inner);
        return node.body.flatMap((child) => walk(child, inner));
      }
      default:
        return childNodes(node).flatMap((child) => walk(child, scope));
    }
  }

  function element(node: t.JSXElement, scope: Env): ElementNode[] {
    const file = scope.module.path;
    const tag = evaluator.resolveTag(node.openingElement.name, scope);
    const children: ElementNode[] = [];
    const props: Record<string, PropValue> = {};
    let open: string | undefined;
    let text = "";
    let dynamic = false;

    for (const attribute of node.openingElement.attributes) {
      children.push(...walk(attribute, scope));
      if (attribute.type === "JSXSpreadAttribute") {
        const spread = evaluator.evaluate(attribute.argument, scope);
        if (spread.k === "obj") {
          for (const [key, value] of spread.entries) props[key] = shallow(value);
          if (spread.open) open = spread.open;
        } else {
          open = `a spread at line ${locationOf(file, attribute).line} may set any prop`;
        }
        continue;
      }
      const name = attribute.name.type === "JSXIdentifier" ? attribute.name.name : `${attribute.name.namespace.name}:${attribute.name.name.name}`;
      if (name === "key" || name === "ref") continue;
      const value = attribute.value;
      if (!value) props[name] = { kind: "literal", value: true };
      else if (value.type === "StringLiteral") props[name] = { kind: "literal", value: value.value };
      else if (value.type === "JSXElement" || value.type === "JSXFragment") props[name] = { kind: "elements" };
      else if (value.expression.type !== "JSXEmptyExpression") {
        const expression = value.expression;
        props[name] = rendersOrCalls(expression) ? { kind: "dynamic", reason: "holds JSX or a function" } : shallow(evaluator.evaluate(expression, scope));
      }
    }

    for (const child of node.children) {
      if (child.type === "JSXText") text += cleanJsxText(child.value);
      else if (child.type === "JSXElement" || child.type === "JSXFragment") {
        const nested = walk(child, scope);
        children.push(...nested);
        for (const item of nested) {
          text += item.text;
          dynamic ||= item.textDynamic;
        }
      } else if (child.type === "JSXExpressionContainer" && child.expression.type !== "JSXEmptyExpression") {
        const literal = child.expression.type === "StringLiteral" ? child.expression.value : null;
        if (literal !== null) text += literal;
        else {
          dynamic = true;
          children.push(...walk(child.expression, scope));
        }
      } else if (child.type === "JSXSpreadChild") dynamic = true;
    }

    if (tag.kind === "fragment") return children;
    const kind = tag.kind === "component" ? "component" : tag.kind;
    return [
      {
        kind,
        name: tag.name,
        at: locationOf(file, node),
        origin: originOf(file, node),
        props: sorted(props),
        ...(open ? { openProps: open } : {}),
        text: text.replace(/\s+/g, " ").trim(),
        textDynamic: dynamic,
        conditional: false,
        repeated: false,
        ...(tag.kind === "unresolved" ? { reason: tag.reason } : {}),
        children,
      },
    ];
  }
}

function rendersOrCalls(expression: t.Node): boolean {
  return expression.type === "JSXElement" || expression.type === "JSXFragment" || expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression";
}

function shallow(value: Value): PropValue {
  if (value.k === "lit") return value.v === undefined ? { kind: "dynamic", reason: "undefined" } : { kind: "literal", value: value.v };
  if (value.k === "choice" && value.of.every((option) => option.k === "lit" && option.v !== undefined)) {
    return { kind: "choice", values: value.of.map((option) => (option.k === "lit" ? (option.v ?? null) : null)) };
  }
  if (value.k === "render") return { kind: "elements" };
  return { kind: "dynamic", reason: value.k === "unknown" ? value.why : "computed" };
}

function sorted(props: Record<string, PropValue>): Record<string, PropValue> {
  return Object.fromEntries(Object.keys(props).sort().map((key) => [key, props[key] as PropValue]));
}
