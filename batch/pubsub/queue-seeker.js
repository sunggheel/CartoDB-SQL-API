'use strict';

var QUEUE = require('../job_queue').QUEUE;
var MAX_SCAN_ATTEMPTS = 50;

function QueueSeeker(pool) {
    this.pool = pool;
}

module.exports = QueueSeeker;

QueueSeeker.prototype.seek = function (callback) {
    var initialCursor = ['0'];
    var attemps = 0;
    var users = {};
    var self = this;

    this.pool.acquire(QUEUE.DB, function(err, client) {
        if (err) {
            return callback(err);
        }
        self._seek(client, initialCursor, users, attemps, function(err, users) {
            self.pool.release(QUEUE.DB, client);
            return callback(err, Object.keys(users));
        });
    });
};

QueueSeeker.prototype._seek = function (client, cursor, users, attemps, callback) {
    var self = this;
    var redisParams = [cursor[0], 'MATCH', QUEUE.PREFIX + '*'];

    client.scan(redisParams, function(err, currentCursor) {
        if (err) {
            return callback(null, users);
        }

        var queues = currentCursor[1];
        if (Array.isArray(queues)) {
            for (var i = 0; i < queues.length; i++) {
                var user = queues[i].substr(QUEUE.PREFIX.length);
                users[user] = true;
            }
        }

        var hasMore = (parseInt(currentCursor[0], 10) > 0) && (attemps < MAX_SCAN_ATTEMPTS);

        if (!hasMore) {
            return callback(null, users);
        }

        attemps += 1;

        self._seek(client, currentCursor, users, attemps, callback);
    });
};
