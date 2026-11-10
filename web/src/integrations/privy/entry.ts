// Buffer must be installed before any browser signing library executes.
import "../../polyfills";
import "../../design/tokens.css";
import "./privy-sign.css";
import { readPrivyConfig } from "./config";
import { loadDrawingSessionRecord } from "../../drawing-session";
import { mountPrivySignPage } from "./sign-page";

const root = document.getElementById("privy-root");
if (root) {
  const availability = readPrivyConfig(import.meta.env, window.location.origin);
  if (availability.state !== "ready") {
    root.textContent =
      availability.state === "disabled"
        ? "Social login is not enabled for this deployment."
        : availability.reason;
  } else if (!window.opener) {
    root.textContent =
      "Open social login from the Meta Poo wallet control. This page never signs requests on its own.";
  } else {
    void import("./runtime")
      .then(({ createPrivyRuntime }) => {
        const page = mountPrivySignPage(root, {
          config: availability.config,
          runtime: createPrivyRuntime(availability.config),
          storage: window.localStorage,
          boardContractId: import.meta.env.VITE_CONTRACT_ID ?? "",
          drawingPublicKey: loadDrawingSessionRecord()?.publicKey,
          location: window.location,
          navigate: (url) => window.location.assign(url),
          replaceUrl: (url) => window.history.replaceState(null, "", url),
          close: () => window.close(),
        });
        window.addEventListener("pagehide", () => page.dispose(), {
          once: true,
        });
      })
      .catch(() => {
        root.textContent =
          "The sign-in service could not load. Return to the game and try again.";
      });
  }
}
