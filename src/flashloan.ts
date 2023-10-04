import { BigNumber, ethers, providers, Wallet } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from "@flashbots/ethers-provider-bundle";
import { v4 as uuidv4 } from "uuid";
import FlashloanArbitrageABI from "./constants/FlashloanArbitrage.json";
import { LegacyTransaction } from "./type";

const ArbitragerAddress = "0x10e0564886F0E56f31D375Bb6CcFf300FD58c715";
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8";
const DAI = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";
const GWEI = BigNumber.from(10).pow(9);
const PRIORITY_FEE = GWEI.mul(3);
const LEGACY_GAS_PRICE = GWEI.mul(12);
const BLOCKS_IN_THE_FUTURE = 2;

async function execute(amount: string | number) {
  const CHAIN_ID = process.env.IS_PRODUCTION === "true" ? 1 : 11155111;
  const provider = new providers.WebSocketProvider(
    CHAIN_ID === 1 ? process.env.NODE_WSS || "" : process.env.NODE_WSS_SEPOLIA || ""
  );
  const FLASHBOTS_EP = CHAIN_ID === 1 ? "https://relay.flashbots.net/" : "https://relay-sepolia.flashbots.net";

  for (const e of ["FLASHBOTS_AUTH_KEY", "PRIVATE_KEY", "TOKEN_ADDRESS"]) {
    if (!process.env[e]) {
      console.warn(`${e} should be defined as an environment variable`);
    }
  }

  const authSigner = process.env.FLASHBOTS_AUTH_KEY
    ? new Wallet(process.env.FLASHBOTS_AUTH_KEY)
    : Wallet.createRandom();
  const wallet = new Wallet(process.env.PRIVATE_KEY || "", provider);
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, FLASHBOTS_EP);

  const connectedWallet = wallet.connect(provider);
  const arbitrageInterface = new ethers.utils.Interface(FlashloanArbitrageABI);

  const arbitrager = new ethers.Contract(ArbitragerAddress, FlashloanArbitrageABI, connectedWallet);

  console.log(`
    Only the owner of Arbitrage contract can call this function.

    Did you check the following requirements?
    1. Ensure that some funds are deposited in the Arbitrage contract.
    2. Confirm that USDC and DAI are approved
  `);

  const initialUsdcBalance = await arbitrager.getBalance(USDC);
  if (parseFloat(ethers.utils.formatEther(initialUsdcBalance)) === 0) {
    console.error("Err: Please deposit some USDC first to Arbitrage contract for loan fee \n");
    process.exit(1);
  }

  const usdcAllowance = await arbitrager.allowanceUSDC();
  const daiAllowance = await arbitrager.allowanceDAI();
  if (
    parseFloat(ethers.utils.formatEther(usdcAllowance)) === 0 ||
    parseFloat(ethers.utils.formatUnits(daiAllowance, 6)) === 0
  ) {
    console.error("Err: Check if you have enough USDC, DAI allowance on contract \n");
  }

  const params = [USDC, ethers.utils.parseUnits(amount.toString(), 6).toString()];

  const userStats = flashbotsProvider.getUserStatsV2();

  const legacyTransaction: LegacyTransaction = {
    to: ArbitragerAddress,
    gasPrice: LEGACY_GAS_PRICE,
    gasLimit: 500000,
    data: arbitrageInterface.encodeFunctionData("requestFlashLoan", params),
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
        to: ArbitragerAddress,
        type: 2,
        maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: PRIORITY_FEE,
        gasLimit: 500000,
        data: arbitrageInterface.encodeFunctionData("requestFlashLoan", params),
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
    // const simulation = await flashbotsProvider.simulate(signedTransactions, targetBlock);

    // // Using TypeScript discrimination
    // if ("error" in simulation) {
    //   console.warn(`Simulation Error: ${simulation.error.message}`);
    //   process.exit(1);
    // } else {
    //   console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);
    // }

    const bundleSubmission = await flashbotsProvider.sendRawBundle(signedTransactions, targetBlock, {
      replacementUuid,
    });
    console.log("bundle submitted, waiting");
    if ("error" in bundleSubmission) {
      throw new Error(bundleSubmission.error.message);
    }

    const waitResponse = await bundleSubmission.wait();
    console.log(`Wait Response: ${FlashbotsBundleResolution[waitResponse]}`);
    if (
      waitResponse === FlashbotsBundleResolution.BundleIncluded ||
      waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh
    ) {
      process.exit(0);
    } else {
      console.log({
        // bundleStatsV2: await flashbotsProvider.getBundleStatsV2(simulation.bundleHash, targetBlock),
        userStats: await userStats,
      });
    }
  });
}

export default execute;
