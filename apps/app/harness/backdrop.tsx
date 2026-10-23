/*
 * Built only for the browser tests (MAVNA_BROWSER_HARNESS=1): the app's
 * backdrop alone, without the widget over it, so a spec can see the canvas
 * whole and tell a running shader from a held one and from none at all.
 */
import { createRoot } from "react-dom/client";
import { Backdrop } from "../src/backdrop";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");
createRoot(container).render(<Backdrop />);
