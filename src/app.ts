import express, { Request } from "express";
import cors from "cors";
import jwt, { Algorithm } from "jsonwebtoken";
import expressJwt from "express-jwt";
import morgan from "morgan";
import bodyParser from "body-parser";
import path from "path";
import { inspect } from "util";
import _ from "lodash";
import { createConnection } from "typeorm";
import * as SibApiV3Sdk from "@sendinblue/client";
import {
	authRouter,
	roleRouter,
	permissionRouter,
	yearRouter,
	ideaRouter,
	categoryRouter,
	departmentRouter,
	userRouter
} from "@app/routes";
import { errorsMiddleware, utilsMiddleware } from "@app/middlewares";
import { Roles, setupDatabase } from "@app/database";
import { ApplicationConfig } from "@app/interfaces";

const config: ApplicationConfig = {
	serverHost: process.env.SERVER_HOST || "localhost",
	serverPort: _.toNumber(process.env.SERVER_PORT) || 5000,
	serverEnvironment: process.env.NODE_ENV || "development",
	databaseHost: process.env.DATABASE_HOST || "localhost",
	databasePort: _.toNumber(process.env.DATABASE_PORT) || 5432,
	databaseName: process.env.DATABASE_NAME || "cmsdb",
	databaseUsername: process.env.DATABASE_USERNAME || "postgres",
	databasePassword: process.env.DATABASE_PASSWORD || "postgres",
	jwtSecret: process.env.JWT_SECRET || "4DFFBC3C4864E2F9A8647E79446FA",
	jwtAlgorithm: (process.env.JWT_ALGORITHM as Algorithm) || "HS256",
	jwtExpiresIn: process.env.JWT_EXPIRES_IN || 86400,
	saltLength: _.toNumber(process.env.SALT_LENGTH) || 32,
	keyLength: _.toNumber(process.env.KEY_LENGTH) || 64,
	emailSender: process.env.EMAIL_SENDER || ""
};
const guestToken = jwt.sign(
	{
		role: Roles.GUEST
	},
	config.jwtSecret,
	{ algorithm: config.jwtAlgorithm }
);

console.log("Guest token: ", guestToken);

morgan.token("error", (req: Request) => {
	if (_.isNil(req.error)) {
		return "";
	}
	return `\n----------ERROR----------\n${inspect(req.error, false, null, true)}\n-------------------------\n`;
});

createConnection({
	type: "postgres",
	host: config.databaseHost,
	port: config.databasePort,
	database: config.databaseName,
	username: config.databaseUsername,
	password: config.databasePassword,
	entities: [path.join(__dirname, "database", "entities", "*.js")],
	synchronize: config.serverEnvironment === "development" ? true : false,
	cache: true
})
	.then(setupDatabase)
	.then(() => {
		const app = express();

		Error.captureStackTrace;

		app.config = config;

		app.emailer = new SibApiV3Sdk.TransactionalEmailsApi();
		app.emailer.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, process.env.EMAIL_API_KEY);

		app.use(
			cors({
				origin: config.serverEnvironment === "development" ? "http://localhost:3000" : "*" //for now
			})
		);
		app.use(
			morgan(
				':remote-addr - :remote-user [:date] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :error'
			)
		);
		app.use(bodyParser.json());
		app.use(bodyParser.urlencoded({ extended: false }));
		app.use(
			expressJwt({
				secret: config.jwtSecret,
				algorithms: [config.jwtAlgorithm],
				credentialsRequired: false,
				getToken: (req) => {
					let tokenRequest = req.headers.authorization || "";
					if (_.isEmpty(tokenRequest) && _.isString(req.query.token)) {
						tokenRequest = req.query.token;
					}
					const tokenSplit: string[] = tokenRequest.split(" ");
					if (tokenSplit.length === 2 && tokenSplit[0] === "Bearer") {
						return tokenSplit[1].trim();
					}
					if (tokenSplit[0].length === 0) {
						return guestToken;
					}
					return tokenSplit[0].trim();
				}
			})
		);
		app.use(utilsMiddleware);

		app.use("/auth", authRouter());
		app.use("/roles", roleRouter());
		app.use("/permissions", permissionRouter());
		app.use("/years", yearRouter());
		app.use("/ideas", ideaRouter());
		app.use("/categories", categoryRouter());
		app.use("/departments", departmentRouter());
		app.use("/users", userRouter());

		app.use(errorsMiddleware);

		app.listen(config.serverPort, config.serverHost, () => {
			console.log(`Server started on http://${config.serverHost}:${config.serverPort}`);
		});
	});
