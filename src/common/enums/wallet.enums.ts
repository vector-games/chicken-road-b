/**
 * Wallet API Action Enum
 * Defines the types of wallet operations
 */
export enum WalletApiAction {
  GET_BALANCE = 'getBalance',
  PLACE_BET = 'placeBet',
  SETTLE_BET = 'settleBet',
  REFUND_BET = 'refundBet',
}

/**
 * Wallet Error Type Enum
 * Defines the types of errors that can occur during wallet operations
 */
export enum WalletErrorType {
  NETWORK_ERROR = 'network_error',
  HTTP_ERROR = 'http_error',
  TIMEOUT_ERROR = 'timeout_error',
  INVALID_RESPONSE = 'invalid_response',
  AGENT_REJECTED = 'agent_rejected',
  MALFORMED_RESPONSE = 'malformed_response',
  UNKNOWN_ERROR = 'unknown_error',
}









