import "@tounsoo/todae/todae.css";
import "./app/app.css";
import { DensityProvider, ThemeProvider } from "@tounsoo/todae";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <ThemeProvider appearance="system" className="app-theme">
    <DensityProvider density="compact" className="app-density">
      <App />
    </DensityProvider>
  </ThemeProvider>,
);
