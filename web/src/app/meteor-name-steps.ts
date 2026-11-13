/**
 * DRAFT — NOT VERIFIED ON A DEVICE.
 *
 * The Meteor Wallet steps for the "Get a name" section of /how-it-works (NAMES, spec §3.4).
 * They were drafted on 13 Nov 2026 from Meteor's published guide, not from a phone. The owner's
 * rule is that these steps are checked on a real device before players read them, so the whole
 * feature stays off (`VITE_NAMES_GUIDE`, default off) until that is done.
 *
 * OWNER CHECKLIST — do this on a phone, then on a desktop browser:
 *
 *  1. Open METEOR.walletUrl. Is it still the right address, and is the first button still
 *     labelled "Get Started"? Correct `walletUrl` and step 1.
 *  2. Create an account. Does Meteor let you type the name, and does it end in `.near`?
 *     Is there still a captcha? Is the button "Create Wallet"? Correct step 2.
 *  3. COST. Did creating the named account cost anything, or need NEAR in it first? Meteor's
 *     guide says "no cost" and its FAQ lists a ~0.000042 NEAR network fee, but neither is dated.
 *     Write what you saw into `cost.text` and set `cost.verified` to true. While it is false the
 *     page prints no cost at all.
 *  4. When is the recovery phrase shown: before or after the account exists? Correct step 3.
 *  5. Come back to Meta Poo. In the wallet panel press "Disconnect", then "Connect wallet",
 *     and pick Meteor. Does it offer the new named account? Does the header then show the
 *     name? Correct steps 4 and 5. Do this once from a wallet sign-in and once from a Privy
 *     sign-in.
 *  6. On a phone: is there a Meteor mobile app now, and does the connect list open it, or the
 *     web wallet? Note anything a phone player has to do differently in `phoneNote`.
 *  7. Confirm the honest part: the new named account shows 0 tiles, 0 credits, 0 TOILET.
 *  8. Set `VERIFIED_ON_DEVICE` to true (this removes the draft notice on the page), then set
 *     `VITE_NAMES_GUIDE=true` in the build environment. That one flag switches on the section
 *     and every "Get a name →" link.
 *
 * Sources (read 13 Nov 2026; Meteor's own site, meteorwallet.app, refused automated reads):
 *  - Meteor guide, wallet overview: "Get Started", pick a name or take the random one, captcha,
 *    "Create Wallet"; named accounts "at no cost"; web wallet recommended over the extension;
 *    mobile apps described as still in development (the page says "by Q3 2024", so it is old):
 *    https://meteorwallet.gitbook.io/harvest-moon-guide/meteor-wallet/the-simplest-and-most-secure-wallet-for-your-crypto-access-defi-and-explore-web3
 *  - Meteor FAQ, typical network fees ("Account Creation: Approximately 0.000042 NEAR") and
 *    recovery phrase warning:
 *    https://meteorwallet.gitbook.io/harvest-moon-guide/meteor-wallet/faq
 *  - NEAR account-id rules (named vs implicit accounts, allowed characters):
 *    https://docs.near.org/protocol/accounts-contracts/account-id
 */

/** False until the owner has walked every step above on a device. */
export const VERIFIED_ON_DEVICE = false;

export interface MeteorStep {
  title: string;
  body: string;
}

export interface MeteorGuide {
  walletName: string;
  walletUrl: string;
  /** What a named account costs to create. Printed only when `verified` is true. */
  cost: { text: string; verified: boolean };
  steps: MeteorStep[];
  /** Anything a phone player does differently. Empty prints nothing. */
  phoneNote: string;
}

export const METEOR: MeteorGuide = {
  walletName: "Meteor Wallet",
  // UNVERIFIED: from Meteor's guide, which calls the web wallet the recommended one.
  walletUrl: "https://wallet.meteorwallet.app",
  cost: {
    // UNVERIFIED PLACEHOLDER: Meteor's guide says "no cost"; its FAQ lists a network fee of
    // about 0.000042 NEAR. Replace with what the device shows before setting `verified`.
    text: "Meteor doesn’t charge for the name.",
    verified: false,
  },
  steps: [
    {
      // UNVERIFIED: button label "Get Started".
      title: "Open Meteor Wallet",
      body: "Go to wallet.meteorwallet.app and choose Get Started. It runs in your browser, so there’s nothing to install.",
    },
    {
      // UNVERIFIED: name field, captcha, button label "Create Wallet".
      title: "Choose your name",
      body: "Meteor suggests a random name. Replace it with yours, the one you tried above. If someone already has it, Meteor says so and you pick another. Then choose Create Wallet.",
    },
    {
      // UNVERIFIED: when Meteor shows the recovery phrase.
      title: "Save your recovery phrase",
      body: "Meteor gives you 12 words. Write them down and keep them somewhere safe. They are the only way back into the account, and neither Meteor nor Meta Poo can recover them for you.",
    },
    {
      // UNVERIFIED against a live sign-in; labels are this site's own ("Disconnect", "Connect wallet").
      title: "Come back and connect it",
      body: "Back here, open your account at the top of the page and choose Disconnect. Then choose Connect wallet and pick Meteor Wallet.",
    },
    {
      title: "Paint",
      body: "Your name shows at the top of the page. From now on, every tile you paint carries it.",
    },
  ],
  phoneNote: "",
};
