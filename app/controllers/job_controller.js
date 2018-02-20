const util = require('util');

const userMiddleware = require('../middlewares/user');
const { initializeProfilerMiddleware, finishProfilerMiddleware } = require('../middlewares/profiler');
const authorizationMiddleware = require('../middlewares/authorization');
const errorMiddleware = require('../middlewares/error');

function JobController(userDatabaseService, jobService, statsdClient) {
    this.userDatabaseService = userDatabaseService;
    this.jobService = jobService;
    this.statsdClient = statsdClient;
}

module.exports = JobController;

JobController.prototype.route = function (app) {
    const { base_url } = global.settings;
    const jobMiddlewares = composeJobMiddlewares(
        this.userDatabaseService,
        this.jobService,
        this.statsdClient
    );

    app.get(`${base_url}/jobs-wip`, listWorkInProgressJobs(this.jobService), errorMiddleware());
    app.post(`${base_url}/sql/job`, checkBodyPayloadSize(), jobMiddlewares('create', createJob));
    app.get(`${base_url}/sql/job/:job_id`, jobMiddlewares('retrieve', getJob));
    app.delete(`${base_url}/sql/job/:job_id`, jobMiddlewares('cancel', cancelJob));
};

function composeJobMiddlewares (userDatabaseService, jobService, statsdClient) {
    return function jobMiddlewares (action, jobMiddleware) {
        const forceToBeAuthenticated = true;

        return [
            initializeProfilerMiddleware('job'),
            userMiddleware(),
            authorizationMiddleware(userDatabaseService, forceToBeAuthenticated),
            jobMiddleware(jobService),
            setServedByDBHostHeader(),
            finishProfilerMiddleware(),
            logJobResult(action),
            incrementSuccessMetrics(statsdClient),
            incrementErrorMetrics(statsdClient),
            errorMiddleware()
        ];
    };
}

function cancelJob (jobService) {
    return function cancelJobMiddleware (req, res, next) {
        const { job_id } = req.params;

        jobService.cancel(job_id, (err, job) => {
            if (req.profiler) {
                req.profiler.done('cancelJob');
            }

            if (err) {
                return next(err);
            }

            res.status(200).send(job.serialize());

            next();
        });
    };
}

function getJob (jobService) {
    return function getJobMiddleware (req, res, next) {
        const { job_id } = req.params;

        jobService.get(job_id, (err, job) => {
            if (req.profiler) {
                req.profiler.done('getJob');
            }

            if (err) {
                return next(err);
            }

            res.status(200).send(job.serialize());

            next();
        });
    };
}

function createJob (jobService) {
    return function createJobMiddleware (req, res, next) {
        const params = Object.assign({}, req.query, req.body);

        var data = {
            user: res.locals.user,
            query: params.query,
            host: res.locals.userDbParams.host,
            port: res.locals.userDbParams.port,
            pass: res.locals.userDbParams.pass,
            dbname: res.locals.userDbParams.dbname,
            dbuser: res.locals.userDbParams.user
        };

        jobService.create(data, (err, job) => {
            if (req.profiler) {
                req.profiler.done('createJob');
            }

            if (err) {
                return next(err);
            }

            res.locals.job_id = job.job_id;

            res.status(201).send(job.serialize());

            next();
        });
    };
}

function listWorkInProgressJobs (jobService) {
    return function listWorkInProgressJobsMiddleware (req, res, next) {
        jobService.listWorkInProgressJobs((err, list) => {
            if (err) {
                return next(err);
            }

            res.status(200).send(list);

            next();
        });
    };
}


function checkBodyPayloadSize () {
    return function checkBodyPayloadSizeMiddleware(req, res, next) {
        const payload = JSON.stringify(req.body);

        if (payload.length > MAX_LIMIT_QUERY_SIZE_IN_BYTES) {
            return next(new Error(getMaxSizeErrorMessage(payload)), res);
        }

        next();
    };
}

const ONE_KILOBYTE_IN_BYTES = 1024;
const MAX_LIMIT_QUERY_SIZE_IN_KB = 16;
const MAX_LIMIT_QUERY_SIZE_IN_BYTES = MAX_LIMIT_QUERY_SIZE_IN_KB * ONE_KILOBYTE_IN_BYTES;

function getMaxSizeErrorMessage(sql) {
    return util.format([
            'Your payload is too large: %s bytes. Max size allowed is %s bytes (%skb).',
            'Are you trying to import data?.',
            'Please, check out import api http://docs.cartodb.com/cartodb-platform/import-api/'
        ].join(' '),
        sql.length,
        MAX_LIMIT_QUERY_SIZE_IN_BYTES,
        Math.round(MAX_LIMIT_QUERY_SIZE_IN_BYTES / ONE_KILOBYTE_IN_BYTES)
    );
}

module.exports.MAX_LIMIT_QUERY_SIZE_IN_BYTES = MAX_LIMIT_QUERY_SIZE_IN_BYTES;
module.exports.getMaxSizeErrorMessage = getMaxSizeErrorMessage;

function setServedByDBHostHeader () {
    return function setServedByDBHostHeaderMiddleware (req, res, next) {
        const { userDbParams } = res.locals;

        if (userDbParams.host) {
            res.header('X-Served-By-DB-Host', res.locals.userDbParams.host);
        }

        next();
    };
}

function logJobResult (action) {
    return function logJobResultMiddleware (req, res, next) {
        if (process.env.NODE_ENV !== 'test') {
            console.info(JSON.stringify({
                type: 'sql_api_batch_job',
                username: res.locals.user,
                action: action,
                job_id: req.params.job_id || res.locals.job_id
            }));
        }

        next();
    };
}

const METRICS_PREFIX = 'sqlapi.job';

function incrementSuccessMetrics (statsdClient) {
    return function incrementSuccessMetricsMiddleware (req, res, next) {
        if (statsdClient !== undefined) {
            statsdClient.increment(`${METRICS_PREFIX}.success`);
        }

        next();
    };
}

function incrementErrorMetrics (statsdClient) {
    return function incrementErrorMetricsMiddleware (err, req, res, next) {
        if (statsdClient !== undefined) {
            statsdClient.increment(`${METRICS_PREFIX}.error`);
        }

        next(err);
    };
}
