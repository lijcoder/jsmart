import * as Lark from "@larksuiteoapi/node-sdk";

const baseConfig = {
	appId: process.env.FEISHU_APP_ID ?? "",
	appSecret: process.env.FEISHU_APP_SECRET ?? "",
};

const client = new Lark.Client({
	appId: baseConfig.appId,
	appSecret: baseConfig.appSecret,
});

// 构建 client Build client
const wsClient = new Lark.WSClient(baseConfig);

// 建立长连接 Establish persistent connection
wsClient.start({
	// 注册事件 Register event
	eventDispatcher: new Lark.EventDispatcher({}).register({
		"im.message.receive_v1": async (data) => {
			const {
				message: { message_id, message_type, content },
			} = data;
			console.log(data);
			let file_key: string;
			let file_name: string;
			if (message_type === "file") {
				file_key = JSON.parse(content).file_key;
				file_name = JSON.parse(content).file_name;
			} else {
				return;
			}
			await client.im.v1.messageResource
				.get({
					path: {
						message_id: message_id,
						file_key: file_key,
					},
					params: {
						type: message_type,
					},
				})
				.then((res) => {
					res.writeFile(`/tmp/agent_test/${file_name}`);
				})
				.catch((e) => {
					console.error(e);
				});
		},
	}),
});
