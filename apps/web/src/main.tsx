import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mavna/widget/widget.css";
import "lenis/dist/lenis.css";
import { Landing } from "./Landing.js";
import "./landing.css";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");

createRoot(container).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
