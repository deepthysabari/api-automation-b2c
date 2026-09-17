const axios = require('axios');
const config = require('../config/config');

const apiClient = axios.create({
  baseURL: config.baseUrl,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

// Request interceptor for auth token and logging
apiClient.interceptors.request.use(
  (req) => {
    // If URL starts with http or a placeholder, it's an absolute/dynamic URL
    if (req.url.startsWith('http') || req.url.startsWith('{{')) {
      req.baseURL = '';
    }

    if (config.token) {
      req.headers['Authorization'] = `Bearer ${config.token}`;
    }
    if (config.clientAppHeaderName && config.clientAppHeaderValue) {
      req.headers[config.clientAppHeaderName] = config.clientAppHeaderValue;
    }
    if (config.debug) {
      console.log(`[REQUEST] ${req.method.toUpperCase()} ${req.url}`);
      if (req.data) console.log(`[PAYLOAD]`, JSON.stringify(req.data, null, 2));
    }
    return req;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for logging
apiClient.interceptors.response.use(
  (res) => {
    if (config.debug) {
      console.log(`[RESPONSE] ${res.status} ${res.config.url}`);
      // Only log a snippet of response if too large
      const logData = JSON.stringify(res.data).length > 10000
        ? { message: 'Response too large to log fully' }
        : res.data;
      console.log(`[BODY]`, JSON.stringify(logData, null, 2));
    }
    return res;
  },
  (error) => {
    if (config.debug && error.response) {
      console.error(`[ERROR] ${error.response.status} ${error.response.config.url}`);
      console.error(`[ERROR_BODY]`, JSON.stringify(error.response.data, null, 2));
    }
    return Promise.reject(error);
  }
);

// LIVE-ONLY CLIENT.
// This is an end-to-end API test engine: every request hits the real Akbar B2B
// API. There is NO mock / fixture / synthetic-response path. A scenario with no
// live inventory must SKIP (empty search, GetSPricer Code 2255), never be
// fabricated — a green result must mean the live API actually served it.
// The proxy below only performs one live-data transformation; it never
// short-circuits a call with a canned response.
const originalApiClient = apiClient;

const wrappedApiClient = new Proxy(originalApiClient, {
  apply(target, thisArg, argumentsList) {
    const requestConfig = argumentsList[0] || {};
    const { url, data } = requestConfig;

    // Live CreateItinerary: rewrite the outgoing payload to the current B2B
    // structure. `data.NetAmount` already carries this scenario's own priced
    // amount (executor resolved it from this scenario's own context — e.g.
    // `{{FinalAmount}}` from its own GetSPricer response — before the request
    // reached this proxy), so it must be used as-is. A previous version of
    // this proxy shadowed it with a module-level `lastGetSPricerNetAmount`
    // captured from whichever GetSPricer call happened to run last — safe
    // only when scenarios execute strictly one at a time. Now that scenarios
    // can run concurrently, that global would leak one scenario's priced
    // amount into another's CreateItinerary call.
    if (url && url.includes('/Flights/CreateItinerary') && data) {
      try {
        console.log('[apiClient] Live CreateItinerary: Overriding payload with the new B2B structure...');

        // Dynamically map incoming random travellers or fall back to template default
        const travellersList = (Array.isArray(data.Travellers) && data.Travellers.length > 0)
          ? data.Travellers.map((t, idx) => ({
              "ID": t.ID || (idx + 1),
              "PaxID": "ZGdiZ2VjYg==",
              "Operation": "0",
              "Title": t.Title || "Mr",
              "FName": t.FName,
              "LName": t.LName || "TESTAB",
              "Email": "neethu.prathapan@benzyinfotech.com",
              "PMobileNo": "",
              "Age": t.Age || 30,
              "DOB": t.DOB || "1996-03-13",
              "Country": "",
              "Gender": t.Gender || "M",
              "PTC": t.PTC || "ADT",
              "Nationality": t.Nationality || "IN",
              "PassportNo": t.PassportNo || "346654",
              "PLI": t.PLI || "IN",
              "PDOI": "",
              "PDOE": t.PDOE || "2031-05-13",
              "VisaType": "PERMANENT RESIDENT VISA",
              "EmigrationCheck": false,
              "isOptionSelected": false,
              "ApproverManagers": {
                "Managers": [],
                "Type": ""
              },
              "DocumentType": "",
              "NationalityName": "INDIA",
              "PLIName": "INDIA",
              "CountryName": "",
              "CDCNo": "",
              "VisaStatus": "",
              "VIPFlag": false,
              "AssocADTPaxID": ""
            }))
          : [
              {
                "ID": 1,
                "PaxID": "ZGdiZ2VjYg==",
                "Operation": "0",
                "Title": "Mr",
                "FName": "SWATHY",
                "LName": "MENON",
                "Email": "neethu.prathapan@benzyinfotech.com",
                "PMobileNo": "",
                "Age": 30,
                "DOB": "1996-03-13",
                "Country": "",
                "Gender": "M",
                "PTC": "ADT",
                "Nationality": "IN",
                "PassportNo": "346654",
                "PLI": "IN",
                "PDOI": "",
                "PDOE": "2031-05-13",
                "VisaType": "PERMANENT RESIDENT VISA",
                "EmigrationCheck": false,
                "isOptionSelected": false,
                "ApproverManagers": {
                  "Managers": [],
                  "Type": ""
                },
                "DocumentType": "",
                "NationalityName": "INDIA",
                "PLIName": "INDIA",
                "CountryName": "",
                "CDCNo": "",
                "VisaStatus": "",
                "VIPFlag": false,
                "AssocADTPaxID": ""
              }
            ];

        // Construct the new payload template using dynamic keys from the pricing response
        const newPayload = {
          "TUI": data.TUI,
          "ServiceEnquiry": "",
          "ContactInfo": {
            "Title": "",
            "FName": "",
            "LName": "",
            "Mobile": "9526835735",
            "DestMob": "9526835735",
            "Phone": "",
            "Email": "deepthy.g@benzyinfotech.com",
            "Language": "",
            "Address": "Cochin , 123,6th floor,Cochin Benzytest tower 1, , benzy ,",
            "CountryCode": "IN",
            "MobileCountryCode": "+91",
            "DestMobCountryCode": "+91",
            "State": "Kerala",
            "City": "Cochin",
            "PIN": "682024",
            "GSTCompanyName": "",
            "GSTTIN": "",
            "GstMobile": "",
            "GSTEmail": "",
            "UpdateProfile": false,
            "IsGuest": false,
            "SaveGST": false
          },
          "DestinationContactInfo": {
            "Address1": "",
            "Address2": "",
            "City": "",
            "Mobile": "",
            "Phone": "",
            "Email": "",
            "CountryCode": "",
            "MobileCountryCode": "+91",
            "State": "",
            "PIN": ""
          },
          "Travellers": travellersList,
          "PLP": [],
          "SSR": data.SSR || null,
          "CrossSell": [],
          "Attachment": "",
          "TravellerDocumentList": [],
          "Declarations": {
            "EmployeeConfirm": false,
            "TravelAgree": false,
            "SafetyConfirm": false,
            "DocsSubmitted": false
          },
          "DealInfo": [],
          "DealEdit": [],
          "DRefNo": "",
          "DRefName": "",
          "AgentATI": "",
          "AgentATIName": "",
          "MultiInvoice": false,
          "SeamanAck": false,
          "CrossSellAmount": 0,
          "EnableFareMasking": false,
          "SSRAmount": data.SSRAmount !== undefined ? data.SSRAmount : 0,
          "ClientID": data.ClientID,
          "DeviceID": "",
          "AppVersion": "",
          "AgentTourCode": "",
          "SequenceID": data.SequenceID !== undefined ? data.SequenceID : 1,
          "RefTransactionID": data.RefTransactionID || undefined,
          "NetAmount": data.NetAmount,
          "BRulesAccepted": ""
        };

        // Apply the new B2B structure to requestConfig.data
        requestConfig.data = newPayload;

        console.log('[apiClient] Live CreateItinerary: Payload successfully overridden.');
        if (config.debug) {
          console.log('[PAYLOAD OVERRIDE]', JSON.stringify(newPayload, null, 2));
        }
      } catch (err) {
        console.error('[apiClient] Error during CreateItinerary payload override:', err);
      }
    }

    return Reflect.apply(target, thisArg, argumentsList);
  }
});

module.exports = wrappedApiClient;
