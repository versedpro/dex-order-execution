# Guide

### Execute orders

1. Fill necessary parameter to execute function.

- go to `src/index.ts` and find `execute()` function at last line.

- parameter is amount of first token. (USDC token in case of USDC-DAI pair) In this case, USDC has 6 decimals, so if you give 1000 then it would be $0.001 USDC. This is formula: 1000 / 10 ^ 6 = 0.001

  **see how to form params of transaction at line 65 of `src/flashloan.ts` file.**

Here is the explanation of function.

```javascript
/**
 * Executes a flash loan arbitrage transaction.
 *
 * @param {string | number} amount - The amount of the flash loan.
 * @return {Promise<void>} - A promise that resolves when the transaction is complete.
 */
```

2. Run the script

- run this command to execute the function: `yarn start` or `npm run start`

- when the transaction has been included, the process will stop autocatically. It means that flashbots's own builder executes the trasaction bypass mempool.
