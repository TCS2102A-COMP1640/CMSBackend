import { Router } from "express";
import { Parser } from "json2csv";
import { getRepository, Repository } from "typeorm";
import { query, checkSchema, param } from "express-validator";
import { StatusCodes } from "http-status-codes";
import {
	AcademicYear,
	Idea,
	Permissions,
	Comment,
	Category,
	Document,
	Reaction,
	Reactions,
	View,
	Role,
	User
} from "@app/database";
import { asyncRoute, getPagination, permission, throwError } from "@app/utils";
import { PassThrough } from "stream";
import { readFile } from "fs/promises";
import archiver from "archiver";
import multer from "multer";
import path from "path";
import _ from "lodash";

const json2csvParser = new Parser();

const upload = multer({
	storage: multer.diskStorage({
		destination: (req, file, callback) => {
			callback(null, "./uploads/");
		},
		filename: (req, file, callback) => {
			callback(null, `${Date.now()}${path.extname(file.originalname)}`);
		}
	}),
	limits: { fileSize: 52428800 }, //50MB
	fileFilter: (req, file, callback) => {
		const fileTypes = /jpeg|jpg|png|pdf|doc/;
		const mimeType = fileTypes.test(file.mimetype);

		const extName = fileTypes.test(path.extname(file.originalname).toLowerCase());

		if (mimeType && extName) {
			return callback(null, true);
		}

		callback(new Error(`File upload only supports the following filetypes - ${fileTypes}`));
	}
});

function isYearValid(year: AcademicYear): "valid" | "closure" | "invalid" {
	const currentDate = new Date();
	if (year.openingDate <= currentDate && currentDate <= year.closureDate) {
		return "valid";
	} else if (year.closureDate <= currentDate && currentDate <= year.finalClosureDate) {
		return "closure";
	}
	return "invalid";
}

export function ideaRouter(): Router {
	const router = Router();
	const repositoryIdea: Repository<Idea> = getRepository(Idea);
	const repositoryYear: Repository<AcademicYear> = getRepository(AcademicYear);
	const repositoryCategory: Repository<Category> = getRepository(Category);
	const repositoryDocument: Repository<Document> = getRepository(Document);
	const repositoryComment: Repository<Comment> = getRepository(Comment);
	const repositoryReaction: Repository<Reaction> = getRepository(Reaction);
	const repositoryRole: Repository<Role> = getRepository(Role);
	const repositoryView: Repository<View> = getRepository(View);
	const orders = { reactions: "idea_reaction_score", views: "idea_view_count", latest: "idea.createTimestamp" };

	router.get(
		"/",
		permission(Permissions.IDEA_GET_ALL),
		checkSchema({
			page: {
				in: "query",
				optional: true,
				isInt: true,
				toInt: true
			},
			pageLimit: {
				in: "query",
				optional: true,
				isInt: true,
				toInt: true
			},
			academicYear: {
				in: "query",
				exists: true,
				custom: {
					options: (value: any) => {
						return repositoryYear.findOneOrFail({ id: _.toInteger(value) });
					}
				}
			},
			order: {
				in: "query",
				optional: true,
				isString: true
			}
		}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				const { page, pageLimit } = getPagination(req);

				const order = _.get(req.query, "order", undefined);

				if (!_.isNil(order) && !(order in orders)) {
					throwError(StatusCodes.BAD_REQUEST, "Unknown sorting order");
				}

				let query = repositoryIdea
					.createQueryBuilder("idea")
					.leftJoinAndSelect("idea.user", "user")
					.leftJoinAndSelect("idea.categories", "categories")
					.leftJoinAndSelect("idea.documents", "documents")
					.leftJoinAndSelect("user.department", "department")
					.select(["idea.id", "idea.content", "idea.createTimestamp", "idea.isAnonymous"])
					.addSelect(["user.id", "user.firstName", "user.lastName"])
					.addSelect(["department.id", "department.name"])
					.addSelect(["categories.id", "categories.name"])
					.addSelect(["documents.id", "documents.name", "documents.path"])
					.addSelect(
						(qb) => qb.from(View, "view").select(`COUNT(view.ideaId)`).where(`view.ideaId = idea.id`),
						"idea_view_count"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 1 THEN 1 WHEN 2 THEN -1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_reaction_score"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 1 THEN 1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_thumb_up_count"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 2 THEN 1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_thumb_down_count"
					)
					.where("idea.academicYear = :academicYearId", { academicYearId: req.query.academicYear })
					.skip(page * pageLimit)
					.take(pageLimit);

				if (!_.isNil(order)) {
					query = query.orderBy(orders[order as keyof typeof orders], "DESC");
				}

				const count = await repositoryIdea
					.createQueryBuilder("idea")
					.where("idea.academicYear = :academicYearId", { academicYearId: req.query.academicYear })
					.getCount();
				const { raw, entities } = await query.getRawAndEntities();
				entities.forEach((idea, index) => {
					idea.viewCount = _.toInteger(raw[index]["idea_view_count"]);
					idea.reactionScore = _.toInteger(raw[index]["idea_reaction_score"]);
					idea.thumbUpCount = _.toInteger(raw[index]["idea_thumb_up_count"]);
					idea.thumbDownCount = _.toInteger(raw[index]["idea_thumb_down_count"]);

					if (idea.isAnonymous) {
						idea.user = _.omit(idea.user, ["firstName", "lastName"]) as User;
					}
				});

				res.json({
					pages: Math.ceil(count / pageLimit),
					data: entities
				});
			}
		})
	);

	router.get(
		"/csv",
		permission(Permissions.IDEA_GET_ALL_CSV),
		query("academicYear")
			.exists()
			.toInt()
			.custom((value) => {
				return repositoryYear.findOneOrFail({ id: value });
			}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				const academicYear = await repositoryYear.findOne({ id: _.toInteger(req.query.academicYear) });
				const raw = await repositoryIdea
					.createQueryBuilder("idea")
					.leftJoinAndSelect("idea.user", "user")
					.leftJoinAndSelect("idea.categories", "categories")
					.leftJoinAndSelect("user.department", "department")
					.select(["idea.id", "idea.content", "idea.createTimestamp", "idea.isAnonymous"])
					.addSelect(["user.firstName", "user.lastName"])
					.addSelect(["department.name"])
					.addSelect(["categories.name"])
					.addSelect(
						(qb) => qb.from(View, "view").select(`COUNT(view.ideaId)`).where(`view.ideaId = idea.id`),
						"idea_view_count"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 1 THEN 1 WHEN 2 THEN -1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_reaction_score"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 1 THEN 1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_thumb_up_count"
					)
					.addSelect(
						(qb) =>
							qb
								.from(Reaction, "reaction")
								.select(`COALESCE(SUM(CASE reaction.type WHEN 2 THEN 1 ELSE 0 END), 0)`)
								.where("reaction.ideaId = idea.id"),
						"idea_thumb_down_count"
					)
					.where("idea.academicYear = :academicYearId", { academicYearId: academicYear.id })
					.getRawMany();

				const file = Buffer.from(json2csvParser.parse(raw));
				const stream = new PassThrough();
				stream.end(file);

				res.attachment(`ideas_${academicYear.name}.csv`);
				res.contentType("text/csv");
				stream.pipe(res);
			}
		})
	);

	router.get(
		"/documents",
		permission(Permissions.IDEA_GET_ALL_DOCUMENTS),
		query("academicYear")
			.exists()
			.toInt()
			.custom((value) => {
				return repositoryYear.findOneOrFail({ id: value });
			}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				const academicYear = await repositoryYear.findOne({ id: _.toInteger(req.query.academicYear) });
				const ideas = await repositoryIdea
					.createQueryBuilder("idea")
					.leftJoinAndSelect("idea.documents", "documents")
					.select(["idea.id"])
					.addSelect(["documents.name", "documents.path"])
					.where("idea.academicYear = :academicYearId", { academicYearId: academicYear.id })
					.getMany();
				const archive = archiver("zip", {
					zlib: { level: 9 }
				});

				for (const idea of ideas) {
					if (!_.isEmpty(idea.documents)) {
						archive.append(null, { name: `${_.toString(idea.id)}/` });
						for (const document of idea.documents) {
							const buffer = await readFile(document.path);
							archive.append(buffer, { name: `${_.toString(idea.id)}/${document.name}` });
						}
					}
				}

				res.attachment(`documents_${academicYear.name}.zip`);
				res.contentType("application/zip");

				archive.pipe(res);
				archive.finalize();
			}
		})
	);

	router.get(
		"/statistics",
		permission(Permissions.IDEA_GET_ALL_STATISTICS),
		checkSchema({
			academicYear: {
				in: "query",
				exists: true,
				custom: {
					options: (value: any) => {
						return repositoryYear.findOneOrFail({ id: _.toInteger(value) });
					}
				}
			}
		}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				const ideas = await repositoryIdea
					.createQueryBuilder("idea")
					.leftJoinAndSelect("idea.user", "user")
					.leftJoinAndSelect("idea.comments", "comments")
					.leftJoinAndSelect("user.department", "department")
					.select(["idea.isAnonymous"])
					.addSelect(["user.id"])
					.addSelect(["department.name"])
					.addSelect(["comments.isAnonymous"])
					.where("idea.academicYear = :academicYearId", { academicYearId: req.query.academicYear })
					.getMany();

				const result: {
					[index: string]: {
						total: number;
						percentage: number;
						contributors: number | number[];
						anonymousIdeas: number;
						anonymousComments: number;
						ideasWithoutComment: number;
					};
				} = {};

				ideas.forEach((idea) => {
					const key = idea.user.department?.name ?? "Unassigned";
					_.set(result, [key, "total"], _.get(result, [key, "total"], 0) + 1);
					_.set(
						result,
						[key, "contributors"],
						[...(_.get(result, [key, "contributors"], []) as number[]), idea.user.id]
					);
					_.set(
						result,
						[key, "anonymousIdeas"],
						_.get(result, [key, "anonymousIdeas"], 0) + (idea.isAnonymous ? 1 : 0)
					);
					_.set(
						result,
						[key, "anonymousComments"],
						_.get(result, [key, "anonymousComments"], 0) +
							idea.comments.map((comment) => comment.isAnonymous).filter(Boolean).length
					);
					_.set(
						result,
						[key, "ideasWithoutComment"],
						_.get(result, [key, "ideasWithoutComment"], 0) + (idea.comments.length > 0 ? 0 : 1)
					);
				});

				_.forEach(result, (value, key) => {
					_.set(result, [key, "percentage"], _.get(value, "total") / ideas.length);
					_.set(result, [key, "contributors"], _.uniq(_.get(value, "contributors") as number[]).length);
				});

				res.json(result);
			}
		})
	);

	router.get(
		"/:id",
		permission(Permissions.IDEA_GET_BY_ID),
		param("id").isInt(),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				res.json(
					await repositoryIdea
						.createQueryBuilder("idea")
						.leftJoinAndSelect("idea.user", "user")
						.leftJoinAndSelect("idea.categories", "categories")
						.leftJoinAndSelect("idea.documents", "documents")
						.leftJoinAndSelect("idea.views", "views")
						.leftJoinAndSelect("user.department", "department")
						.select(["idea.id", "idea.content", "idea.createTimestamp"])
						.addSelect(["user.id"])
						.addSelect(["department.id", "department.name"])
						.addSelect(["categories.id", "categories.name"])
						.addSelect(["documents.id", "documents.name", "documents.path"])
						.addSelect(["views.createTimestamp", "views.updateTimestamp"])
						.where("idea.id = :ideaId", { ideaId: req.params.id })
						.getOneOrFail()
				);
			}
		})
	);

	router.post(
		"/",
		permission(Permissions.IDEA_CREATE),
		upload.array("documents", 5),
		checkSchema({
			academicYear: {
				in: "body",
				exists: true,
				custom: {
					options: (value: any) => {
						return repositoryYear.findOneOrFail({ id: _.toInteger(value) });
					}
				}
			},
			categories: {
				in: "body",
				optional: true,
				custom: {
					options: (value: any) => {
						value = JSON.parse(value);
						return _.isArray(value) && _.every(value, _.isInteger);
					}
				},
				customSanitizer: {
					options: (value: any) => {
						return JSON.parse(value);
					}
				}
			},
			content: {
				in: "body",
				exists: true,
				notEmpty: true
			},
			isAnonymous: {
				in: "body",
				exists: true,
				isBoolean: true,
				toBoolean: true
			}
		}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				const academicYear = await repositoryYear.findOne({ id: req.body.academicYear });

				if (_.isUndefined(req.user.id) || isYearValid(academicYear) !== "valid") {
					throwError(StatusCodes.BAD_REQUEST, "Invalid year or user ID is undefined");
				}

				const categories = _.isUndefined(req.body.categories)
					? []
					: await repositoryCategory.findByIds(req.body.categories);
				const documents = _.isUndefined(req.files)
					? []
					: (req.files as Express.Multer.File[]).map((file) => {
							return repositoryDocument.create({
								name: file.originalname,
								path: file.path
							});
					  });
				const idea = repositoryIdea.create({
					content: req.body.content,
					user: {
						id: req.user.id
					},
					isAnonymous: req.body.isAnonymous,
					academicYear,
					categories,
					documents
				});
				res.json(await repositoryIdea.save(idea));

				(
					await repositoryRole
						.createQueryBuilder("role")
						.leftJoinAndSelect("role.users", "users")
						.leftJoinAndSelect("role.permissions", "permissions")
						.where("permissions.name IN (:...names)", {
							names: [Permissions.IDEA_CREATE_RECEIVE_EMAIL, Permissions.ALL]
						})
						.getMany()
				)
					.flatMap((role) => role.users)
					.forEach((user) => {
						if (user.id !== idea.user.id) {
							req.app.emailer
								.sendTransacEmail({
									sender: { email: req.app.config.emailSender },
									to: [
										{
											email: user.email,
											name: `${user.firstName} ${user.lastName}`
										}
									],
									subject: "Someone posted a new idea",
									textContent: `A new idea was posted on ${academicYear.name}!\n\n${idea.content}`
								})
								.then()
								.catch(console.error);
						}
					});
			}
		})
	);

	router.get(
		"/:id/comments",
		permission(Permissions.IDEA_GET_ALL_COMMENT),
		param("id").isInt(),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				return res.json(
					(
						await repositoryComment
							.createQueryBuilder("comment")
							.leftJoinAndSelect("comment.user", "user")
							.leftJoinAndSelect("user.department", "department")
							.select(["comment.id", "comment.content", "comment.createTimestamp", "comment.isAnonymous"])
							.addSelect(["user.id", "user.firstName", "user.lastName"])
							.addSelect(["department.id", "department.name"])
							.where("comment.idea = :ideaId", { ideaId: req.params.id })
							.orderBy("comment.createTimestamp", "DESC")
							.getMany()
					).map((comment) => {
						if (comment.isAnonymous) {
							comment.user = _.omit(comment.user, ["firstName", "lastName"]) as User;
						}

						return comment;
					})
				);
			}
		})
	);

	router.post(
		"/:id/comments",
		permission(Permissions.IDEA_CREATE_COMMENT),
		param("id").isInt(),
		checkSchema({
			content: {
				in: "body",
				exists: true,
				isString: true
			},
			isAnonymous: {
				in: "body",
				exists: true,
				isBoolean: true
			}
		}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				if (_.isUndefined(req.user.id)) {
					throwError(StatusCodes.BAD_REQUEST, "User ID is undefined");
				}

				const idea = await repositoryIdea.findOneOrFail(req.params.id, { relations: ["user"] });
				const comment = repositoryComment.create({
					user: {
						id: req.user.id
					},
					idea,
					content: req.body.content,
					isAnonymous: req.body.isAnonymous
				});

				res.json(_.pick(await repositoryComment.save(comment), ["id", "content", "createTimestamp"]));

				if (idea.user.id !== comment.user.id) {
					req.app.emailer
						.sendTransacEmail({
							sender: { email: req.app.config.emailSender },
							to: [
								{
									email: idea.user.email,
									name: `${idea.user.firstName} ${idea.user.lastName}`
								}
							],
							subject: "Someone commented on your idea",
							textContent: `You received a new comment on your idea!\n\n${comment.content}`
						})
						.then()
						.catch(console.error);
				}
			}
		})
	);

	router.get(
		"/:id/reactions",
		permission(Permissions.IDEA_GET_REACTION),
		param("id").isInt(),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				if (_.isUndefined(req.user.id)) {
					throwError(StatusCodes.BAD_REQUEST, "User ID is undefined");
				}
				res.json(
					_.pick(
						(await repositoryReaction.findOne({
							idea: {
								id: _.toInteger(req.params.id)
							},
							user: {
								id: req.user.id
							}
						})) ?? {
							type: Reactions.NONE
						},
						"type"
					)
				);
			}
		})
	);

	router.post(
		"/:id/reactions",
		permission(Permissions.IDEA_CREATE_REACTION),
		checkSchema({
			id: {
				in: "params",
				isInt: true
			},
			type: {
				in: "body",
				isInt: true
			}
		}),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				if (_.isUndefined(req.user.id)) {
					throwError(StatusCodes.BAD_REQUEST, "User ID is undefined");
				}

				const type = Reactions[req.body.type];
				if (_.isNil(type)) {
					throwError(StatusCodes.BAD_REQUEST, "This reaction type does not exist");
				}

				const idea = await repositoryIdea.findOneOrFail(req.params.id);
				let reaction = await repositoryReaction.findOne(
					{
						idea: {
							id: idea.id
						},
						user: {
							id: req.user.id
						}
					},
					{ relations: ["idea", "user"] }
				);

				if (_.isNil(reaction)) {
					reaction = repositoryReaction.create({
						idea: {
							id: idea.id
						},
						user: {
							id: req.user.id
						}
					});
				}

				reaction.type = Reactions[type as keyof typeof Reactions];

				res.json(_.pick(await repositoryReaction.save(reaction), ["type"]));
			}
		})
	);

	router.get(
		"/:id/views",
		permission(Permissions.IDEA_GET_ALL_VIEW),
		param("id").isInt(),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				if (_.isUndefined(req.user.id)) {
					throwError(StatusCodes.BAD_REQUEST, "User ID is undefined");
				}
				res.json(
					await repositoryView.find({
						idea: {
							id: _.toInteger(req.params.id)
						}
					})
				);
			}
		})
	);

	router.post(
		"/:id/views",
		permission(Permissions.IDEA_CREATE_VIEW),
		param("id").isInt(),
		asyncRoute(async (req, res) => {
			if (req.validate()) {
				if (_.isUndefined(req.user.id)) {
					throwError(StatusCodes.BAD_REQUEST, "User ID is undefined");
				}

				const idea = await repositoryIdea.findOneOrFail(req.params.id);
				let view = await repositoryView.findOne(
					{
						idea: {
							id: idea.id
						},
						user: {
							id: req.user.id
						}
					},
					{ relations: ["idea", "user"] }
				);

				if (_.isNil(view)) {
					view = repositoryView.create({
						idea: {
							id: idea.id
						},
						user: {
							id: req.user.id
						}
					});
				}
				view.updateTimestamp = new Date();

				res.json(_.pick(await repositoryView.save(view), ["createTimestamp", "updateTimestamp"]));
			}
		})
	);

	return router;
}
