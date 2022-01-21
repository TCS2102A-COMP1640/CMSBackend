import express, { Request } from "express";
import expressJwt from "express-jwt";
import bodyParser from "body-parser";
import { AuthRoute } from "./routes";
import { AppConfig } from "./types";
import _ from "lodash";

const app = express();
const config: AppConfig = {
	JWT_SECRET: process.env.JWT_SECRET || "Secret Test"
};

app.set("host", process.env.HOST || "localhost");
app.set("port", process.env.PORT || "5000");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(
	expressJwt({
		secret: config.JWT_SECRET,
		algorithms: ["HS256"],
		credentialsRequired: false,
		getToken: (req: Request) => {
			const token = _.get(req.headers, "authorization", _.get(req.query, "token", "")) as string;
			const tokenSplit: string[] = token.split(" ");
			if (tokenSplit.length === 2 && tokenSplit[0] === "Bearer") {
				return tokenSplit[1];
			}
			return token[0];
		}
	})
);

app.use("/api/auth", AuthRoute(config));

app.listen(app.get("port"), app.get("host"), () => {
	console.log(`Server started on port ${app.get("port")}`);
});