import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import authRouter from "./auth";
import inviteRouter from "./invites";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(inviteRouter);
router.use(marketRouter);

export default router;
