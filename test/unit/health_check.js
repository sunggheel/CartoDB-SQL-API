require('../helper')

var assert      = require('assert'),
    _           = require('underscore'),
    HealthCheck = require('../../app/monitoring/health_check');

var metadataBackend = {};

function PSQL(dbParams) {
    this.params = dbParams;
}

var healthCheck = new HealthCheck(metadataBackend, PSQL);

suite('health checks', function() {

    beforeEach(function(done) {
        mockGetAllUserDBParams(function(username, callback) {
            callback(null, {user: 'fake', dbname: 'fake'});
        });

        mockQuery(function(query, callback) {
            callback(null, {rows: [{},{},{}]});
        });

        done();
    });

    test('happy case, everything goes OK', function(done) {
        healthCheck.check('fake', 'select 1::text', function(err, result) {
            assert.ok(result.redis.ok);
            assert.ok(result.redis.elapsed >= 0);
            assert.equal(result.redis.count, 2);

            assert.ok(result.postgresql.ok);
            assert.ok(result.postgresql.elapsed >= 0);
            assert.ok(result.postgresql.count, 3);

            done();
        });
    });

    test('error in metadataBackend reports as false and does not report postgresql except ok=false', function(done) {
        mockGetAllUserDBParams(function() {
            throw "Error";
        });
        healthCheck.check('fake', 'select 1::text', function(err, result) {
            assert.equal(result.redis.ok, false);
            assert.ok(result.redis.elapsed >= 0);
            assert.ok(_.isUndefined(result.redis.count));

            assert.equal(result.postgresql.ok, false);
            assert.ok(_.isUndefined(result.postgresql.elapsed));
            assert.ok(_.isUndefined(result.postgresql.count));

            done();
        });
    });

    test('error in metadataBackend reports as false and does not report postgresql except ok=false', function(done) {
        mockQuery(function() {
            throw "Error";
        });
        healthCheck.check('fake', 'select 1::text', function(err, result) {
            assert.ok(result.redis.ok);
            assert.ok(result.redis.elapsed >= 0);
            assert.equal(result.redis.count, 2);

            assert.equal(result.postgresql.ok, false);
            assert.ok(_.isUndefined(result.postgresql.elapsed));
            assert.ok(_.isUndefined(result.postgresql.count));

            done();
        });
    });

    test('error if disabled file exists', function(done) {
      var fs = require('fs');

      var readFileFn = fs.readFile;
      fs.readFile = function(filename, callback) {
        callback(null, "Maintenance");
      }
      healthCheck.check('fake', 'select 1', function(err, result) {
        assert.equal(err.message, "Maintenance");
        assert.equal(err.http_status, 503);
        done();
        fs.readFile = readFileFn;
      });
    });

    test('not err if disabled file does not exists', function(done) {
      var fs = require('fs');
      
      var readFileFn = fs.readFile;
      fs.readFile = function(filename, callback) {
        callback(new Error("ENOENT"), null);
      }
      healthCheck.check('fake', 'select 1', function(err, result) {
        assert.equal(err, null);
        done();
        fs.readFile = readFileFn;
      });
    });

    function mockGetAllUserDBParams(func) {
        metadataBackend.getAllUserDBParams = func;
    }

    function mockQuery(func) {
        PSQL.prototype.query = func;
    }
});
