# Replab — Ireland clothing resale shop

A responsive Replab storefront and private owner dashboard. The Replab logo is included in `public/assets/`. The shop starts with no products or fake stock: the owner adds genuine items in the dashboard.

## Included
- Storefront, brand/category filters, basket and checkout.
- Delivery in Ireland or local collection.
- Stripe-hosted EUR card checkout (the site never collects card details).
- Private owner dashboard for orders, paid revenue, order status and product management.
- SQLite database and sessions stored on a persistent disk when deployed with the included Render configuration.

## Put the website online (Render)

1. Create a GitHub account at https://github.com/ if you do not already have one.
2. Create a new **private** GitHub repository named `replab-store`.
3. Upload the contents of this folder (`package.json`, `server.js`, `render.yaml`, `.env.example`, `README.md`, and the `public` folder) to the repository's main branch. Do not upload a real `.env` file or any secret keys.
4. Create a Render account at https://render.com/ and choose **New → Blueprint**. Connect GitHub and select the `replab-store` repository. Render reads `render.yaml` and creates the web service and persistent disk.
5. When prompted, enter a strong unique `ADMIN_PASSWORD`. Leave Stripe keys blank until the Stripe account is ready. Deploy.
6. When Render finishes, open the service's `https://...onrender.com` address. The public shop is at that address; the private owner dashboard is at `https://...onrender.com/admin.html`.

**Important hosting cost:** the included Render setup uses a paid Starter web service because the order database needs a persistent disk. Check Render's current pricing before confirming. Do not remove the disk or orders may be lost.

## Set up payments

1. The owner creates a Stripe account at https://stripe.com/ie and completes Stripe's identity/business checks.
2. In Stripe, add and verify the Irish bank account for payouts. Never give the website bank-login details; the bank account is connected securely inside Stripe.
3. Initially use Stripe test mode. Copy the test secret key (`sk_test_...`) into the Render service environment variable `STRIPE_SECRET_KEY`.
4. In Stripe, add a webhook endpoint: `https://YOUR-RENDER-ADDRESS/api/stripe-webhook`. Subscribe to `checkout.session.completed` and `checkout.session.expired`. Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` in Render.
5. Set `BASE_URL` in Render to the exact public HTTPS address, with no trailing slash, then redeploy.
6. Test a full checkout. Only after testing should the owner replace the Stripe test key with the live secret key (`sk_live_...`) and create a live-mode webhook secret.

Stripe approval, fees, payout timing and payment methods are controlled by Stripe. Real payments will not work until the owner's Stripe account and keys are configured.

## First setup in the owner dashboard

1. Open `/admin.html` and sign in with the `ADMIN_PASSWORD` set in Render.
2. Add each real item with its exact brand, name, size, condition, price and description.
3. Hide an item as soon as it sells. This starter does not automatically reserve stock or prevent two customers attempting to buy the same unique item at once.

## Before accepting real orders

Add the seller's real contact details, delivery/collection arrangements, delivery charges and times, returns/refunds policy, privacy notice and terms. Check Irish/EU consumer, tax and data-protection requirements. This starter dashboard does not send customer email confirmations or shipping notifications. Back up the persistent database regularly.

## Local preview

Requires Node.js 20 or newer. Run `npm install`, copy `.env.example` to `.env`, set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`, then run `npm start`. Visit `http://localhost:3000`; dashboard: `http://localhost:3000/admin.html`.
