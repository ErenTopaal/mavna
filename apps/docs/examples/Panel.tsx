/**
 * The whole widget, in an integration the size of the API.
 *
 * One import for the component, one for its stylesheet, and one object of config.
 * The widget quotes, races the rails, connects both wallets, and runs the
 * transfer itself. The host supplies an integrator name and, in production, the
 * URL of a sponsor it runs.
 */
import { MavnaWidget } from "@mavna/widget";
import "@mavna/widget/widget.css";
import type { ReactElement } from "react";

export function Deposit(): ReactElement {
  return (
    <MavnaWidget
      config={{
        integrator: "your-product",
        network: "testnet",
        variant: "compact",
        // Your own sponsor in production. The default is a local dev sponsor,
        // which is why zero-XLM arrival works out of the box only on localhost.
        sponsorUrl: "https://sponsor.your-product.example",
        onEvent: (event) => {
          console.log(event.type);
        },
      }}
    />
  );
}
