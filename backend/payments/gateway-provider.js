const GatewayPaymentProvider = {
  async createPixPayment({ orderId, product }) {
    throw new Error('Gateway payment not implemented yet.');
  },

  async getPaymentStatus(orderId) {
    throw new Error('Gateway payment not implemented yet.');
  },

  validateWebhook(payload, signature) {
    throw new Error('Gateway payment not implemented yet.');
  },
  
  parseWebhook(payload) {
    throw new Error('Gateway payment not implemented yet.');
  }
};

module.exports = GatewayPaymentProvider;
