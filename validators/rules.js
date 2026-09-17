module.exports = {
  successCode: (response) => {
    return response.data.Code === "200";
  },
  hasTrips: (response) => {
    return Array.isArray(response.data.Trips) && response.data.Trips.length > 0;
  },
  positiveAmount: (response) => {
    const amount = response.data.NetAmount || response.data.GrossAmount;
    return typeof amount === 'number' && amount > 0;
  },
  tuiPresent: (response) => {
    return !!response.data.TUI;
  },
  // Legacy rules
  minFlights: (response, min) => {
    return Array.isArray(response.data.Trips) && response.data.Trips.length >= parseInt(min);
  }
};
