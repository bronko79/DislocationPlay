class TastyTradeWebsocketHandler{

    constructor(streamerContext, onWebsocketAuthorized, onFeedMessage) {
        this.onWebsocketAuthorized = onWebsocketAuthorized
        this.onFeedMessage = onFeedMessage

     	this.regex = /.([A-Z]{1,4})(\d{6})([P,C]{1})([.,0-9]*)/;
        this.regexCandleSymbol = /([A-Z]*){=([0-9]*)([a-z])./;

        this.fullSymbolRegEx = /([A-Z ]{6})(\d{6})([CP])(\d{8})/;

        this.websocket = undefined
        this.eventFields = {
            "Quote": ["eventType","eventSymbol","bidPrice","askPrice"],
            "TimeAndSale": ["eventType","eventSymbol","price", "bidPrice", "askPrice", "aggressorSide","size", "spreadLeg", "eventTime", "type", "buyer", "seller", "time", "tradeThroughExempt", "exchangeCode", "eventFlags", "exchangeSaleConditions", "extendedTradingHours", "sequence", "index", "validTick"],
            "Greeks" : ["eventType", "eventSymbol", "time", "eventTime", "price", "volatility", "delta", "gamma", "theta", "rho", "vega"],
            "Summary" : ["eventType", "eventSymbol", "eventTime", "openInterest", "prevDayClosePrice"],
            "Trade" : ["eventType", "eventSymbol", "eventTime", "size", "dayVolume", "price", "dayTurnover", "change"],
            "Order" : ["eventType", "eventSymbol", "eventTime", "marketMaker"],
			"Candle": ["eventSymbol", "eventType", "eventFlags", "close"]
        }

        this.streamerContext = streamerContext
        this.websocket = new WebSocket(this.streamerContext['websocket-url']);
        this.websocket.onopen = this.onOpen.bind(this);



        this.ready = new Promise((resolve, reject) => {
          this.websocket.onopen = () => {
            this.websocket.onmessage = this.onMessage.bind(this);
            this.sendWhenReady('{"type":"SETUP","channel":0,"keepaliveTimeout":60,"acceptKeepaliveTimeout":60,"version":"0.1-js/1.0.0"}')
            resolve();
          }});

    }

    async sendWhenReady(messageToSend) {
        await this.ready;
        this.websocket.send(messageToSend);
    }

    onOpen(evt) {
        console.log(evt)
    }

    fullSymbolToStreamerSymbol(fullSymbol) {
        var streamerSymbol = undefined
        var matches = this.fullSymbolRegEx.exec(fullSymbol);
        if (matches != null && matches.length == 5) {
            var underlying = matches[1].trim()
            var expire = matches[2]
            var optionType = matches[3]
            var strike = (parseFloat(matches[4]) / 1000).toString()

            streamerSymbol = "." + underlying + expire + optionType + strike
        }
        return streamerSymbol
    }

    extendOptionSymbol(item) {
        var matches = this.regex.exec(item.eventSymbol);
        item.isOption = false;
        item.underlying = item.eventSymbol
        if (matches != null && matches.length == 5) {
            item.underlying = matches[1].trim()
            item.expire = matches[2]
            item.optionType = matches[3]
            item.strike = parseFloat(matches[4])
            item.isOption = true;
        }
		return item;
	}

	onCompactFeedMessage(compactData){
		var valuesType = compactData[0]
		var valuesTypeFields = this.eventFields[valuesType].length
		var values = compactData[1]
		for(var i=0; i<values.length;i+=valuesTypeFields){
			var item = []
			for(var j=0; j<valuesTypeFields;j++){
				item[this.eventFields[valuesType][j]] = values[i + j]
			}

			if(item.eventType === "Candle") {
				var matches = this.regexCandleSymbol.exec(item.eventSymbol);
				if (matches != null && matches.length == 4) {
					item.isOption = false;
					item.eventSymbol = matches[1]
					item.underlying = matches[1]
					item.period = matches[2]
					item.unit = matches[3]
					this.onFeedMessage(item)
				}
			} else {
				this.onFeedMessage(this.extendOptionSymbol(item))
			}
		}
	}

    onMessage(evt) {
		var jsonObject = JSON.parse(evt.data);
		if (jsonObject.type == 'ERROR'){
			console.error(jsonObject)
		}

		if (jsonObject.type == 'FEED_DATA'){
		    this.onCompactFeedMessage(jsonObject.data)

		}

		if (jsonObject.type == 'AUTH_STATE' && jsonObject.state == 'UNAUTHORIZED') {
    		this.sendWhenReady('{"type":"AUTH","channel":0,"token":"' + this.streamerContext.token + '"}');
		}

		if (jsonObject.type == 'AUTH_STATE' && jsonObject.state == 'AUTHORIZED') {
			this.sendWhenReady('{"type":"CHANNEL_REQUEST","channel":1,"service":"FEED","parameters":{"contract":"AUTO"}}')

		}

		if (jsonObject.type == 'CHANNEL_OPENED'){
			this.sendWhenReady('{"type":"FEED_SETUP","channel":1,"acceptAggregationPeriod":0.1,"acceptDataFormat":"FULL", "acceptEventFields":' + JSON.stringify(this.eventFields) + ' }')
		    this.onWebsocketAuthorized()
        }

		if (jsonObject.type == 'KEEPALIVE'){
			this.sendWhenReady('{"type":"KEEPALIVE","channel":0}')
		}
    }

	subscribeSymbol(symbolJson) {
        this.sendWhenReady('{"type":"FEED_SUBSCRIPTION","channel":1,"add":' + JSON.stringify(symbolJson) + ' }')
    }
}


class TastyTradeApi {

    constructor(baseUrl = "https://api.tastyworks.com") {
        this.baseUrl = baseUrl
        this.sessionContext = undefined;
        this.streamerContext = undefined
        this.tastyTradeWebsocketHandler = undefined


        this.onWebsocketAuthorized = undefined
        this.onFeedMessage = undefined
    }

    async #doHttpPost(postUrl, bodyPayload) {
		var headers = {}
		if(this.sessionContext === undefined) {
			headers = {
                "Content-Type": "application/json"
            }
		} else {
			headers = {
                "Content-Type": "application/json",
				"Authorization": this.sessionContext['session-token']
            }
		}
        const response = await fetch(postUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(bodyPayload)
        });
        const data = await response.json();
        return data.data
    }

    async #getSessionContext(username, password) {
        return this.#doHttpPost(this.baseUrl + "/sessions", { login: username, password: password, "remember-me": false })
    }

    async #getHttpJson(getUrl) {
        const response = await fetch(getUrl, {
                    method: "GET",
                    headers: {
                        "Authorization": this.sessionContext['session-token']
                    }
                });

        const data = await response.json();
        return data.data
    }

    async #getStreamerContext(sessionContext) {
        var streamerContext = await this.#getHttpJson(this.baseUrl + "/quote-streamer-tokens")
        streamerContext['websocket-url'] = "wss://tasty-live-ws.dxfeed.com/realtime";
        return streamerContext
    }


    ///////////////////////////////////////////////////////////

    async login(username, password) {
        this.sessionContext = await this.#getSessionContext(username, password)
        this.streamerContext = await this.#getStreamerContext(this.sessionContext)
        return this.sessionContext
    }

    async loginWithSession(sessionContext) {
        this.sessionContext = sessionContext
        this.streamerContext = await this.#getStreamerContext(this.sessionContext)
        return this.sessionContext
    }

    connectWebsocket() {
        this.tastyTradeWebsocketHandler = new TastyTradeWebsocketHandler(this.streamerContext, this.onWebsocketAuthorized, this.onFeedMessage)
    }

    subscribeSymbol(symbolJson) {
        this.tastyTradeWebsocketHandler.subscribeSymbol(symbolJson)
    }

    async getOptionChain(symbol) {
        var chain = await this.#getHttpJson(this.baseUrl + "/option-chains/" + symbol);
		return chain
	}

	async getOptionExpiration(underlyingSymbol) {
		var results = await this.#getHttpJson(this.baseUrl + "/option-chains/" + underlyingSymbol + "/nested");
        var mergedItems = []
		for(var i = 0; i < results.items.length;i++) {
		    var item = results.items[i].expirations
		    mergedItems = mergedItems.concat(results.items[i].expirations)
		}

        mergedItems = mergedItems.sort(function (a, b) {
            return a['days-to-expiration'] - b['days-to-expiration'];
        });

		return mergedItems
	}

	async searchSymbol(symbolString) {
		var results = await this.#getHttpJson(this.baseUrl + "/symbols/search/" + symbolString);
		return results.items
	}

	async getAccounts() {
		var accounts = await this.#getHttpJson(this.baseUrl + "/customers/me/accounts");
		return accounts
	}

	async sendDryRun(accountId, payload) {
		var result = this.#doHttpPost(this.baseUrl + "/accounts/" + accountId + "/orders/dry-run", payload)
		return result
	}

	async sendOrder(accountId, payload) {
		var result = this.#doHttpPost(this.baseUrl + "/accounts/" + accountId + "/orders", payload)
		return result
	}

	async getPositions(accountId) {
		var positions = await this.#getHttpJson(this.baseUrl + "/accounts/" + accountId + "/positions");
		return positions.items
	}

	fullSymbolToStreamerSymbol(fullSymbol) {
	    return this.tastyTradeWebsocketHandler.fullSymbolToStreamerSymbol(fullSymbol)
	}

}