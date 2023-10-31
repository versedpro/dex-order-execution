import { BigNumber, ethers, providers, Wallet } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from "@flashbots/ethers-provider-bundle";
import * as dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { DEXS, LegacyTransaction } from "./type";
import execute from "./flashloan";
dotenv.config();

const FLASHBOTS_AUTH_KEY = process.env.FLASHBOTS_AUTH_KEY;

const GWEI = BigNumber.from(10).pow(9);
const PRIORITY_FEE = GWEI.mul(3);
const LEGACY_GAS_PRICE = GWEI.mul(12);
const BLOCKS_IN_THE_FUTURE = 1;

const UniswapRouterABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WETH_GOERLI = "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6";

const addresses = {
  WETH: process.env.IS_PRODUCTION === "true" ? WETH : WETH_GOERLI,
  UNISWAPFACTORY: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  UNISWAPROUTER: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  PANCAKESWAPFACTORY: "",
  PANCAKESWAPROUTER: "0xEfF92A263d31888d860bD50809A8D171709b7b1c",
  RECIPIENT: process.env.RECIPIENT_ADDRESS,
};

/**
 * Execute orders on multiple dexs
 * @param dex the dex's name you wish run your order on
 * @param token0 token address desired to buy
 * @param token1 token address spent on order
 * @param amount token1 amount to execute an order
 */
async function order(dex: string, token0?: string, token1?: string, amount?: string | number) {
  const CHAIN_ID = process.env.IS_PRODUCTION === "true" ? 1 : 5;
  const provider = new providers.WebSocketProvider(
    CHAIN_ID === 1 ? process.env.NODE_WSS || "" : process.env.NODE_WSS_GOERLI || ""
  );
  const FLASHBOTS_EP = CHAIN_ID === 1 ? "https://relay.flashbots.net/" : "https://relay-goerli.flashbots.net/";

  for (const e of ["FLASHBOTS_AUTH_KEY", "PRIVATE_KEY", "TOKEN_ADDRESS"]) {
    if (!process.env[e]) {
      console.warn(`${e} should be defined as an environment variable`);
    }
  }

  let routerAddress: string, routerABI: string[];
  if (dex !== DEXS.PANCAKESWAP) {
    routerAddress = addresses.UNISWAPROUTER;
    routerABI = UniswapRouterABI;
  } else {
    routerAddress = addresses.PANCAKESWAPROUTER;
    routerABI = UniswapRouterABI;
  }

  const authSigner = FLASHBOTS_AUTH_KEY ? new Wallet(FLASHBOTS_AUTH_KEY) : Wallet.createRandom();
  const wallet = new Wallet(process.env.PRIVATE_KEY || "", provider);
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_EP);

  const connectedWallet = wallet.connect(provider);
  const routerInterface = new ethers.utils.Interface(routerABI);

  // const factory = new ethers.Contract(addresses.UNISWAPFACTORY, UniswapFactoryABI, connectedWallet);
  const router = new ethers.Contract(routerAddress, routerABI, connectedWallet);

  let tokenIn, tokenOut;
  if (token0 === addresses.WETH) {
    tokenIn = token0;
    tokenOut = token1;
  }

  if (token1 === addresses.WETH) {
    tokenIn = token1;
    tokenOut = token0;
  }

  if (typeof tokenIn === "undefined") {
    return;
  }
  const amountIn = ethers.utils.parseUnits(amount?.toString() || process.env.AMOUNT_IN || "0.001", "ether");
  const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
  const amountOutMin = amounts[1].sub(amounts[1].div(10));
  console.log(`
    Buying new token
    =================
    tokenIn: ${amountIn.toString()} ${tokenIn} (WETH)
    tokenOut: ${amountOutMin.toString()} ${tokenOut}
  `);

  const params = [amountIn, amountOutMin, [tokenIn, tokenOut], addresses.RECIPIENT, Date.now() + 1000 * 60 * 10];

  const userStats = flashbotsProvider.getUserStatsV2();

  const legacyTransaction: LegacyTransaction = {
    to: routerAddress,
    gasPrice: LEGACY_GAS_PRICE,
    gasLimit: 500000,
    data: routerInterface.encodeFunctionData("swapExactTokensForTokens", params),
    nonce: await provider.getTransactionCount(wallet.address),
    chainId: CHAIN_ID,
  };

  provider.on("block", async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    const replacementUuid = uuidv4();

    let eip1559Transaction;
    if (block.baseFeePerGas == null) {
      console.warn("This chain is not EIP-1559 enabled, defaulting to two legacy transactions for demo");
      eip1559Transaction = { ...legacyTransaction };
      // We set a nonce in legacyTransaction above to limit validity to a single landed bundle. Delete that nonce for tx#2, and allow bundle provider to calculate it
      delete eip1559Transaction.nonce;
    } else {
      const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
        block.baseFeePerGas,
        BLOCKS_IN_THE_FUTURE
      );
      eip1559Transaction = {
        to: routerAddress,
        type: 2,
        maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: PRIORITY_FEE,
        gasLimit: 500000,
        data: routerInterface.encodeFunctionData("swapExactTokensForTokens", params),
        chainId: CHAIN_ID,
      };
    }

    const signedTransactions = await flashbotsProvider.signBundle([
      // {
      //   signer: wallet,
      //   transaction: legacyTransaction,
      // },
      {
        signer: wallet,
        transaction: eip1559Transaction,
      },
    ]);
    const targetBlock = blockNumber + BLOCKS_IN_THE_FUTURE;
    const simulation = await flashbotsProvider.simulate(signedTransactions, targetBlock);

    // Using TypeScript discrimination
    if ("error" in simulation) {
      console.warn(`Simulation Error: ${simulation.error.message}`);
      process.exit(1);
    } else {
      console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);
    }

    const bundleSubmission = await flashbotsProvider.sendRawBundle(signedTransactions, targetBlock, {
      replacementUuid,
    });
    console.log("bundle submitted, waiting");
    if ("error" in bundleSubmission) {
      throw new Error(bundleSubmission.error.message);
    }

    // const cancelResult = await flashbotsProvider.cancelBundles(replacementUuid);
    // console.log("cancel response", cancelResult);

    const waitResponse = await bundleSubmission.wait();
    console.log(`Wait Response: ${FlashbotsBundleResolution[waitResponse]}`);
    if (
      waitResponse === FlashbotsBundleResolution.BundleIncluded ||
      waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
    ) {
      process.exit(0);
    } else {
      console.log({
        bundleStatsV2: await flashbotsProvider.getBundleStatsV2(simulation.bundleHash, targetBlock),
        userStats: await userStats,
      });
    }
  });
}

// order("uniswap", process.env.TOKEN_ADDRESS, addresses.WETH, 0.001);

execute(100);
