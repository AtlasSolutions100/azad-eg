import { Router, type IRouter } from "express";
import healthRouter from "./health";
import workPlansRouter from "./work-plans";
import employeesRouter from "./employees";
import classificationsRouter from "./classifications";
import invoicesRouter from "./invoices";
import packagesRouter from "./packages";
import lineItemsRouter from "./line-items";
import signaturesRouter from "./signatures";
import referenceRouter from "./reference";
import auditLogsRouter from "./audit-logs";
import procasRouter from "./procas";
import dashboardRouter from "./dashboard";
import searchRouter from "./search";
import filesRouter from "./files";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(healthRouter);

router.use(requireAuth);

router.use(dashboardRouter);
router.use(searchRouter);
router.use(workPlansRouter);
router.use(employeesRouter);
router.use(classificationsRouter);
router.use(invoicesRouter);
router.use(packagesRouter);
router.use(lineItemsRouter);
router.use(signaturesRouter);
router.use(referenceRouter);
router.use(auditLogsRouter);
router.use(procasRouter);
router.use(filesRouter);

export default router;
