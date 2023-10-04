import { BigNumber } from "ethers";

export const enum DEXS {
  UNISWAP = "uniswap",
  DODO = "dodo",
  CURVE = "curve",
  MAVERICK = "maverick",
  THORCHAIN = "thorchain",
  BALANCER = "balancer",
  PANCAKESWAP = "pancakeswap",
}

export interface LegacyTransaction {
  to: string;
  gasPrice: BigNumber;
  gasLimit: number;
  data: any;
  nonce?: any;
  chainId: number;
}
