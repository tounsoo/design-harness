import { createElement } from "react";
import { Button } from "@tounsoo/todae";

export const legacyAction = () => createElement(Button.Root, { variant: "primary" }, "Book room");
