---
mode: testing
tags: [smoke, checkout]
---

# Checkout smoke test

End-to-end checkout on Tiny Shop: add two products, check the cart total,
fill in the demo checkout form, place the order, and confirm the order
confirmation page shows the same total. The checkout is a demo flow: the
card number is a test card and no payment is ever taken.

## Open the store

Open http://localhost:3000.

Verify the product list shows at least 4 products.

## Add items to the cart

Add "Wireless Headphones" to the cart, then add "USB-C Cable" to the cart.

Verify the cart shows 2 items.

## Check the cart total

Store the displayed cart total as 'cart_total'.

Verify the cart total is visible.

## Checkout

Click "Checkout".

Fill in the form with name "Test User", email "test@example.com", address
"123 Demo Street", card number "4242424242424242", expiry "12/30", CVC "123".

Click "Place order".

## Confirm the order

Verify the page shows "Order confirmed".

Verify the confirmation total matches the stored cart total value.
