// Имена инструментов. Claude подписывает вызов инструмента локального расширения его
// именем: «get_candles» → «Get candles», а поле title игнорирует. Поэтому имена —
// действия без приставки bybit_: название коннектора и значок и так стоят рядом.
export const TOOL = {
  search: 'search_endpoints',
  describe: 'describe_endpoint',
  read: 'send_read_request',
  trade: 'send_trading_request',
  funds: 'send_funds_request',
  stream: 'watch_stream',
  status: 'connector_status',
  tickers: 'get_tickers',
  candles: 'get_candles',
  orderBook: 'get_order_book',
  recentTrades: 'get_recent_trades',
  fundingHistory: 'get_funding_history',
  openInterest: 'get_open_interest',
  instruments: 'get_instruments',
  walletBalance: 'get_wallet_balance',
  positions: 'get_positions',
  openOrders: 'get_open_orders',
  orderHistory: 'get_order_history',
  tradeHistory: 'get_trade_history',
  placeOrder: 'place_order',
  amendOrder: 'amend_order',
  cancelOrder: 'cancel_order',
  cancelAllOrders: 'cancel_all_orders',
  setLeverage: 'set_leverage',
  setTradingStop: 'set_trading_stop',
};

// Имена до версии 1.1.0. Вызов по старому имени (например, из устаревшего списка
// у клиента) получает подсказку с новым именем.
export const RENAMED = {
  bybit_search_endpoints: TOOL.search,
  bybit_describe_endpoint: TOOL.describe,
  bybit_read: TOOL.read,
  bybit_trade: TOOL.trade,
  bybit_funds: TOOL.funds,
  bybit_stream: TOOL.stream,
  bybit_status: TOOL.status,
  bybit_get_tickers: TOOL.tickers,
  bybit_get_kline: TOOL.candles,
  bybit_get_orderbook: TOOL.orderBook,
  bybit_get_recent_trades: TOOL.recentTrades,
  bybit_get_funding_history: TOOL.fundingHistory,
  bybit_get_open_interest: TOOL.openInterest,
  bybit_get_instruments: TOOL.instruments,
  bybit_get_wallet_balance: TOOL.walletBalance,
  bybit_get_positions: TOOL.positions,
  bybit_get_open_orders: TOOL.openOrders,
  bybit_get_order_history: TOOL.orderHistory,
  bybit_get_executions: TOOL.tradeHistory,
  bybit_place_order: TOOL.placeOrder,
  bybit_amend_order: TOOL.amendOrder,
  bybit_cancel_order: TOOL.cancelOrder,
  bybit_cancel_all_orders: TOOL.cancelAllOrders,
  bybit_set_leverage: TOOL.setLeverage,
  bybit_set_trading_stop: TOOL.setTradingStop,
};

// Инструмент, который выполняет методы каждого уровня доступа.
export const TIER_TOOL = { read: TOOL.read, trade: TOOL.trade, funds: TOOL.funds };
