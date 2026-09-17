module.exports = {
  signatureSchema: {
    type: "object",
    required: ["Token", "TUI", "ClientID", "Code"],
    properties: {
      Token: { type: "string" },
      TUI: { type: "string" },
      ClientID: { type: "string" },
      Code: { type: "string" }
    }
  },
  searchInitiatedSchema: {
    type: "object",
    required: ["TUI", "Code"],
    properties: {
      TUI: { type: "string" },
      Code: { type: "string" }
    }
  },
  searchResultSchema: {
    type: "object",
    required: ["Trips", "TUI", "Code"],
    properties: {
      Trips: { type: "array" },
      TUI: { type: "string" },
      Code: { type: "string" }
    }
  },
  pricingSchema: {
    type: "object",
    required: ["NetAmount", "Code", "Msg"],
    properties: {
      NetAmount: { type: "number" },
      Code: { type: "string" },
      Msg: { type: "array", items: { type: "string" } }
    }
  }
};
