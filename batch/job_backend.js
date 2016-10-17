'use strict';

var REDIS_PREFIX = 'batch:jobs:';
var REDIS_DB = 5;
var JobStatus = require('./job_status');

function JobBackend(metadataBackend, jobQueue) {
    this.metadataBackend = metadataBackend;
    this.jobQueue = jobQueue;
    this.maxNumberOfQueuedJobs = global.settings.batch_max_queued_jobs || 100;
    this.inSecondsJobTTLAfterFinished = global.settings.finished_jobs_ttl_in_seconds || 2 * 3600; // 2 hours
}

function toRedisParams(job) {
    var redisParams = [REDIS_PREFIX + job.job_id];
    var obj = JSON.parse(JSON.stringify(job));
    delete obj.job_id;

    for (var property in obj) {
        if (obj.hasOwnProperty(property)) {
            redisParams.push(property);
            if (property === 'query' && typeof obj[property] !== 'string') {
                redisParams.push(JSON.stringify(obj[property]));
            } else {
                redisParams.push(obj[property]);
            }
        }
    }

    return redisParams;
}

function toObject(job_id, redisParams, redisValues) {
    var obj = {};

    redisParams.shift(); // job_id value
    redisParams.pop(); // WARN: weird function pushed by metadataBackend

    for (var i = 0; i < redisParams.length; i++) {
        // TODO: this should be moved to job model
        if (redisParams[i] === 'query') {
            try {
                obj[redisParams[i]] = JSON.parse(redisValues[i]);
            } catch (e) {
                obj[redisParams[i]] = redisValues[i];
            }
        } else if (redisValues[i]) {
            obj[redisParams[i]] = redisValues[i];
        }
    }

    obj.job_id = job_id; // adds redisKey as object property

    return obj;
}

function isJobFound(redisValues) {
    return !!(redisValues[0] && redisValues[1] && redisValues[2] && redisValues[3] && redisValues[4]);
}

JobBackend.prototype.get = function (job_id, callback) {
    var self = this;
    var redisParams = [
        REDIS_PREFIX + job_id,
        'user',
        'status',
        'query',
        'created_at',
        'updated_at',
        'host',
        'failed_reason',
        'fallback_status'
    ];

    self.metadataBackend.redisCmd(REDIS_DB, 'HMGET', redisParams , function (err, redisValues) {
        if (err) {
            return callback(err);
        }

        if (!isJobFound(redisValues)) {
            var notFoundError = new Error('Job with id ' + job_id + ' not found');
            notFoundError.name = 'NotFoundError';
            return callback(notFoundError);
        }

        var jobData = toObject(job_id, redisParams, redisValues);

        callback(null, jobData);
    });
};

JobBackend.prototype.create = function (job, callback) {
    var self = this;

    this.jobQueue.size(job.user, function(err, size) {
        if (err) {
            return callback(new Error('Failed to create job, could not determine user queue size'));
        }

        if (size >= self.maxNumberOfQueuedJobs) {
            return callback(new Error('Failed to create job, max number of jobs queued reached'));
        }

        self.get(job.job_id, function (err) {
            if (err && err.name !== 'NotFoundError') {
                return callback(err);
            }

            self.save(job, function (err, jobSaved) {
                if (err) {
                    return callback(err);
                }

                self.jobQueue.enqueue(job.user, job.job_id, function (err) {
                    if (err) {
                        return callback(err);
                    }

                    return callback(null, jobSaved);
                });
            });
        });
    });
};

JobBackend.prototype.update = function (job, callback) {
    var self = this;

    self.get(job.job_id, function (err) {

        if (err) {
            return callback(err);
        }

        self.save(job, callback);
    });
};

JobBackend.prototype.save = function (job, callback) {
    var self = this;
    var redisParams = toRedisParams(job);

    self.metadataBackend.redisCmd(REDIS_DB, 'HMSET', redisParams , function (err) {
        if (err) {
            return callback(err);
        }

        self.setTTL(job, function (err) {
            if (err) {
                return callback(err);
            }

            self.get(job.job_id, function (err, job) {
                if (err) {
                    return callback(err);
                }

                callback(null, job);
            });
        });
    });
};

JobBackend.prototype.setTTL = function (job, callback) {
    var self = this;
    var redisKey = REDIS_PREFIX + job.job_id;

    if (!JobStatus.isFinal(job.status)) {
        return callback();
    }

    self.metadataBackend.redisCmd(REDIS_DB, 'EXPIRE', [ redisKey, this.inSecondsJobTTLAfterFinished ], callback);
};

module.exports = JobBackend;
