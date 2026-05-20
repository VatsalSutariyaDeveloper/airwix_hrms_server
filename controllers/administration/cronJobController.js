const { CronJobRun, Logs } = require("../../models");
const { commonQuery } = require("../../helpers");
const { revertCronJobRun, runJobNow, ALL_JOBS } = require("../../jobs/cronJobs");
const { constants } = require("../../helpers/constants");

/**
 * Controller to manage Cron Job Runs and History
 */
const CronJobController = {
    /**
     * Fetch list of cron job runs with pagination
     */
    fetchCronJobRuns: async (req, res) => {
        try {
            const { page = 1, limit = 10, search = "" } = req.body;
            
            const fieldConfig = [
                ["job_name", true, true],
                ["status", true, true],
                ["start_time", true, true],
                ["end_time", true, true],
            ];

            const result = await commonQuery.fetchPaginatedData(
                CronJobRun,
                req.body,
                fieldConfig,
                {
                    order: [["start_time", "DESC"]],
                    skipStatus: true
                },
                {}
            );

            return res.success(constants.DATA_FETCHED, result);
        } catch (error) {
            console.error("Error fetching cron job runs:", error);
            return res.error(constants.INTERNAL_SERVER_ERROR, error.message);
        }
    },

    /**
     * Fetch details of a specific run (including summary and linked logs)
     */
    fetchRunDetails: async (req, res) => {
        try {
            const { id } = req.params;
            const run = await commonQuery.findOneRecord(CronJobRun, id, {
                skipStatus: true,
                include: [
                    {
                        model: Logs,
                        as: "logs",
                        limit: 100, // Limit logs to avoid huge payload
                        attributes: ["id", "entity_name", "action_type", "record_id", "log_message", "status", "old_data", "new_data"]
                    }
                ]
            }, null, false, {});

            if (!run) return res.error(constants.NOT_FOUND, "Run not found");

            return res.success(constants.DATA_FETCHED, run);
        } catch (error) {
            console.error("Error fetching run details:", error);
            return res.error(constants.INTERNAL_SERVER_ERROR, error.message);
        }
    },

    /**
     * Revert a specific cron job run
     */
    revertRun: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await revertCronJobRun(id);
            return res.success("Run reverted successfully", result);
        } catch (error) {
            console.error("Error reverting run:", error);
            return res.error(constants.INTERNAL_SERVER_ERROR, error.message);
        }
    },

    /**
     * Trigger a job manually
     */
    triggerJob: async (req, res) => {
        try {
            const { jobKey, asOf } = req.body;
            if (!jobKey) return res.error(constants.VALIDATION_ERROR, "jobKey is required");
            
            const result = await runJobNow(jobKey, asOf);
            return res.success("Job triggered successfully", result);
        } catch (error) {
            console.error("Error triggering job:", error);
            return res.error(constants.INTERNAL_SERVER_ERROR, error.message);
        }
    },

    /**
     * Get list of available jobs for manual trigger
     */
    getAvailableJobs: async (req, res) => {
        try {
            const jobs = ALL_JOBS.map(j => ({ name: j.name }));
            return res.success(constants.DATA_FETCHED, jobs);
        } catch (error) {
            return res.error(constants.INTERNAL_SERVER_ERROR, error.message);
        }
    }
};

module.exports = CronJobController;
