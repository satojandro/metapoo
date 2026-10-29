/**
 * Close affordances for the Paint & wallet `<details>` panel.
 * Native details only close via the summary click, which is easy to miss once
 * the panel is an absolute overlay.
 */

export interface WalletDetailsCloseHandles {
  dispose(): void;
}

/**
 * Wire Close, Escape, and outside-click so the panel can always be dismissed.
 */
export function wireWalletDetailsClose(
  details: HTMLDetailsElement,
): WalletDetailsCloseHandles {
  const toolbar = document.createElement("div");
  toolbar.className = "wallet-details-toolbar";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "action secondary wallet-details-close";
  closeButton.setAttribute("aria-label", "Close Paint and wallet");
  closeButton.textContent = "Close";
  toolbar.append(closeButton);

  const summary = details.querySelector("summary");
  if (summary?.nextSibling) {
    details.insertBefore(toolbar, summary.nextSibling);
  } else {
    details.append(toolbar);
  }

  function close(): void {
    details.open = false;
  }

  const onCloseClick = (event: MouseEvent): void => {
    event.preventDefault();
    close();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!details.open) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (details.contains(target)) {
      return;
    }
    close();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && details.open) {
      close();
    }
  };

  closeButton.addEventListener("click", onCloseClick);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown);

  return {
    dispose() {
      closeButton.removeEventListener("click", onCloseClick);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      toolbar.remove();
    },
  };
}
