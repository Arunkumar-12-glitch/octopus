import "server-only";
import { runRepositoryIndex } from "@/lib/repository-index-completion";
import { prisma } from "@octopus/db";
import { pubby } from "@/lib/pubby";
import { clearAbortController } from "@/lib/indexing-abort";
import { eventBus } from "@/lib/events";
import type { LogLevel } from "@/lib/indexer";

export async function runIndexingInBackground(
  repoId: string,
  fullName: string,
  defaultBranch: string,
  organizationId: string,
  installationId: number,
  channel: string,
  emitLog: (message: string, level?: LogLevel) => void,
  abortController: AbortController,
  provider: string = "github",
) {
  try {
    const { indexRepository: runIndexing } = await import("@/lib/indexer");
    const stats = await runRepositoryIndex(repoId, () => runIndexing(
      repoId,
      fullName,
      defaultBranch,
      installationId,
      emitLog,
      abortController.signal,
      provider,
      organizationId,
    ), abortController.signal);


    emitLog(`Indexing completed for ${fullName}`, "success");

    // Generate summary with AI
    emitLog("Generating repository summary with AI...");
    try {
      const { summarizeRepository } = await import("@/lib/summarizer");
      const { summary, purpose } = await summarizeRepository(repoId, fullName, organizationId);

      await prisma.repository.update({
        where: { id: repoId },
        data: { summary, purpose },
      });

      emitLog("Repository summary generated", "success");
    } catch (summarizeError) {
      console.error("Failed to generate summary:", summarizeError);
      emitLog("Summary generation failed (indexing still succeeded)", "warning");
    }

    clearAbortController(repoId);

    eventBus.emit({
      type: "repo-indexed",
      orgId: organizationId,
      repoFullName: fullName,
      success: true,
      indexedFiles: stats.indexedFiles,
      totalVectors: stats.totalVectors,
      durationMs: stats.durationMs,
    });

    pubby.trigger(channel, "index-status", {
      repoId,
      status: "indexed",
    });
  } catch (error) {
    clearAbortController(repoId);

    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const isCancelled = abortController.signal.aborted || errorMsg === "Indexing cancelled";

    console.error(`Failed to index repo ${fullName}:`, error);


    if (isCancelled) {
      emitLog("Indexing cancelled by user", "warning");
      pubby.trigger(channel, "index-status", {
        repoId,
        status: "cancelled",
      });
    } else {
      const needsAccess = errorMsg.includes("does not have access");
      emitLog(`Indexing failed: ${errorMsg}`, "error");
      eventBus.emit({
        type: "repo-indexed",
        orgId: organizationId,
        repoFullName: fullName,
        success: false,
        error: errorMsg,
      });
      pubby.trigger(channel, "index-status", {
        repoId,
        status: "failed",
        needsAccess,
      });
    }
  }
}
