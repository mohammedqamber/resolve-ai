import cors from "cors";
import express from "express";
import { apiRouter } from "./api/chat.routes.js";
import { errorHandler, notFoundHandler } from "./api/http.js";

// Builds the Express app without starting it, so tests can start their own copy.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors()); // yo yo sir allow browsers on any website to call the API
  app.use(express.json({ limit: "10kb" })); // request-size limit

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler); // must be last
  return app;
}
