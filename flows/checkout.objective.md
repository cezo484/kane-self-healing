# Checkout objective (inline version)

Same flow as `checkout_test.md`, as a single objective string for
`kane-cli run`. The heal loop uses the testmd file by default; pass
`--mode run` to use this objective instead.

```text
Go to http://localhost:3000 and verify the product list shows at least 4
products. Add "Wireless Headphones" to the cart, then add "USB-C Cable" to
the cart, and verify the cart shows 2 items. Store the displayed cart total
as 'cart_total'. Click "Checkout", fill in the form with name "Test User",
email "test@example.com", address "123 Demo Street", card number
"4242424242424242", expiry "12/30", CVC "123", and click "Place order".
Verify the page shows "Order confirmed" and the confirmation total matches
the stored cart total value.
```
