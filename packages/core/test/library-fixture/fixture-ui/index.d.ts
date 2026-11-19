/* eslint-disable @typescript-eslint/no-explicit-any -- the describer reads exactly these forms */
import type { ComponentPropsWithoutRef, Context, ElementType, ForwardRefExoticComponent, ReactNode, RefAttributes } from "react";

export * as Callout from "./callout";

type Responsive<T> = T | { initial?: T; md?: T };

export interface ButtonRootProps extends ComponentPropsWithoutRef<"button"> {
  /** A union of string literals: an enum. */
  variant?: "primary" | "secondary" | "ghost";
  /** The open-string idiom: its literals. */
  size?: "sm" | "md" | (string & {});
  /** A responsive value: its literals. */
  gap?: Responsive<"1" | "2">;
  loading?: boolean;
  /** Numbers. */
  count?: number;
  order?: 1 | 2 | 3;
  /** Text. */
  label?: string;
  /** JSX or text: a spec gives the text. */
  hint?: ReactNode;
  /** An object: unknown. */
  gradient?: { from: string; to: string };
  /** Unlike types: unknown. */
  width?: 1 | "auto";
  /** Anything: unknown. */
  extra?: any;
}

/** A compound component as an object: Button.Root and Button.Icon. */
export declare const Button: {
  Root: ForwardRefExoticComponent<ButtonRootProps & RefAttributes<HTMLButtonElement>>;
  Icon: (props: { name: "check" | "close" }) => ReactNode;
};

/** A plain component. */
export declare function Badge(props: { tone?: "info" | "warning"; children?: ReactNode }): ReactNode;

/** A component with statics: Accordion, Accordion.Item and Accordion.Trigger. */
export declare const Accordion: ((props: { multiple?: boolean; children?: ReactNode }) => ReactNode) & {
  Item: (props: { value: string; children?: ReactNode }) => ReactNode;
  Trigger: (props: { children?: ReactNode }) => ReactNode;
  /** Lowercase: not a part. */
  extend: (input: object) => object;
};

/** A bound value: a prop with its on<Prop>Change. A required object it cannot take: in needs. */
export declare function Select(props: { value?: string; onValueChange?: (value: string) => void; data: readonly { value: string }[] }): ReactNode;

/** A callback named for the prop that reports something else: not bindable. */
export declare function Amount(props: { value?: string; onValueChange?: (values: { floatValue: number }) => void }): ReactNode;

/** Children as a function: no content. */
export declare function Measure(props: { children: (width: number) => ReactNode }): ReactNode;

/** A polymorphic component, generic in its element: read as a tag would instantiate it. */
export declare const Box: <C extends ElementType = "div">(props: { component?: C; padding?: "xs" | "md" } & Omit<ComponentPropsWithoutRef<C>, "padding">) => ReactNode;

/** A context is callable in React 19's types, but not a part. */
export declare const ThemeContext: Context<string>;

/** Not components. */
export declare const Sizes: { readonly sm: number };
export declare function helper(): number;
