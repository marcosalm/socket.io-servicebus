/**
* Copyright (c) Microsoft.  All rights reserved.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';

var should = require('should')
  , sinon = require('sinon');

var ServiceBusConnector = require('../lib/servicebusconnector');

var nodeId = 'aNode';
var topicName = 'aTopic';
var subscriptionName = 'aSubscription';

describe('Service Bus connection layer', function () {

  describe('when starting', function () {
    var connector;
    var serviceBusService;

    beforeEach(function () {
      makeConnectorWithMockSB(function (sb, c) {
        serviceBusService = sb;
        connector = c;
      });
      connector.start();
    });

    it('should start polling service bus', function () {
      serviceBusService.receiveSubscriptionMessage.calledOnce.should.be.true;
    });
  });

  describe('when created without a subscription id', function () {
    var connector;
    var serviceBusService;

    beforeEach(function () {
      serviceBusService = {
        sendTopicMessage: sinon.spy(),
        receiveSubscriptionMessage: sinon.spy(),
        createSubscription: sinon.spy(),
        withFilter: function () { return this; }
      };

      makeConnector(serviceBusService, function (_, c) {
        connector = c;
      });
      connector.start();
    });

    it('should attempt to create a subscription', function () {
      serviceBusService.createSubscription.calledOnce.should.be.true;
    });
  });

  describe('when packing messages to send', function () {
    var connector;
    var serviceBusService;

    beforeEach(function () {
      makeConnectorWithMockSB(function (sb, c) {
        serviceBusService = sb;
        connector = c;
      });
    });

    it('should put nodeId in correlation id', function () {
      var packed = connector.packMessage('msg', 'hello');

      packed.brokerProperties.CorrelationId.should.equal(nodeId);
    });

    it('should put message name in label', function () {
      var packed = connector.packMessage('aMessage', [1, 2, 3]);

      packed.brokerProperties.Label.should.equal('aMessage');
    });

    it('should round trip nodeId and message name through unpack', function () {
      var packed = connector.packMessage('msg', 'hello');
      var unpacked = connector.unpackMessage(packed);
      unpacked.nodeId.should.equal(nodeId);
    });

    it('should round trip message args through unpack', function () {
      var packed = connector.packMessage('msg', {a: 'hello', b: 5});
      var unpacked = connector.unpackMessage(packed);

      unpacked.args.a.should.equal('hello');
      unpacked.args.b.should.equal(5); 
    });

    it('should pull sequence number from broker properties', function () {
      var packed = connector.packMessage('msg', 'world');
      packed.brokerProperties.SequenceNumber = 53;
      var unpacked = connector.unpackMessage(packed);

      should.exist(unpacked.seq);
      unpacked.seq.should.equal(53);
    });
  });

  describe('when sending', function () {
    var sb;
    var connector;

    beforeEach(function () {
      makeConnectorWithMockSB(function (mockServiceBus, newConnector) {
        sb = mockServiceBus;
        connector = newConnector;
      });
    });

    it('should pass sent message to servicebus', function () {
      connector.send('msg', 'hello');

      sb.sendTopicMessage.calledOnce.should.be.true;
    });

    it('should pack message that was sent', function () {
      connector.send('msg', 'hello');

      var sentMessage = sb.sendTopicMessage.firstCall.args[1];

      sentMessage.body.should.equal('"hello"');
    });
  });

  describe('when receiving with one receive at a time', function () {
    var sb;
    var connector;
    var receive;

    beforeEach(function () {
      sb = {
        sendTopicMessage: sinon.spy(),
        receiveSubscriptionMessage: sinon.spy(function (topic, subscription, callback) {
          receive = callback;
        }),
        createSubscription: function (topic, sub, opts, cb) { cb(); },
        withFilter: sinon.spy()
      };

      makeConnector(sb, function (serviceBus, newConnector) {
        connector = newConnector;
        connector.start();
      });
    });

    it('should raise message event when message is received', function (done) {
      connector.on('message', function (nodeId, name, args, metadata) {
        done();
      });

      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [1, 2, 3], 8));
    });

    it('should pass nodeId from received message', function (done) {
      connector.on('message', function (nodeId, name, args, metadata) { 
        nodeId.should.equal('anotherNode');
        done();
      });

      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [1, 2, 3], 8));
    });

    it('should pass message name from received message', function (done) {
      connector.on('message', function (nodeId, name, args, metadata) { 
        name.should.equal('aMessage');
        done();
      });

      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [1, 2, 3], 8));
    });

    it('should pass message arguments from received message', function (done) {
      connector.on('message', function (nodeId, name, args, metadata) { 
        args.should.have.length(3);
        args[0].should.equal(3);
        args[1].should.equal(1);
        args[2].should.equal(4);
        done();
      });

      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [3, 1, 4], 8));
    });

    it('should pass sequence number from message properties', function(done) {
      connector.on('message', function (nodeId, name, args, seq) {
        seq.should.equal(7);
        done();
      });

      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [1, 5, 9], 7));
    });

    it('should repoll service bus after message is received', function () {
      receive(null, packMessage(connector, 'anotherNode', 'aMessage', [3, 1, 4], 8));

      sb.receiveSubscriptionMessage.calledTwice.should.be.true;
    });

    it('should not raise event and repoll on receive error', function (done) {
      connector.on('message', function (nodeId, name, args, seq) {
        done(new Error('Should not be called')); 
      });

      receive(new Error('Fake error'), null);
      sb.receiveSubscriptionMessage.calledTwice.should.be.true;
      done();
    });

    it('should not raise message event and repoll on undeserializable message', function (done) {
      connector.on('message', function (nodeId, name, args, seq) {
        done(new Error('Message received when deserialization fails. This should not happen.'));
      });

      var msg = packMessage(connector, 'anotherNode', 'aMessage', null, 12);
      msg.body = 'This is not valid JSON';
      receive(null, msg);
      sb.receiveSubscriptionMessage.calledTwice.should.be.true;
      done();
    });

    it('should raise badmessage event on undeserializable message', function (done) {
      connector.on('badmessage', function (nodeId, name, seq) {
        nodeId.should.equal('anotherNode');
        name.should.equal('aMessage');
        seq.should.equal(12);
        done();
      });

      var msg = packMessage(connector, 'anotherNode', 'aMessage', null, 12);
      msg.body = 'This is not valid JSON';
      receive(null, msg);
      sb.receiveSubscriptionMessage.calledTwice.should.be.true;      
    });
  });

  describe('when receiving with multiple receives at a time', function () {
    var sb;
    var connector;
    var receive;
    var numReceives = 8;
    beforeEach(function () {
      receive = [];

      sb = {
        sendTopicMessage: sinon.spy(),
        receiveSubscriptionMessage: sinon.spy(function (topic, subscription, callback) {
          receive.push(callback);
        }),
        createSubscription: function (topic, sub, opts, cb) { cb(); },
        withFilter: sinon.spy()
      };

      connector = new ServiceBusConnector({
        nodeId: nodeId,
        topic: topicName,
        subscription: subscriptionName,
        serviceBusService: sb,
        numReceives: numReceives
      });

      connector.start();
    });

    it('should raise message event when message is received', function (done) {
      connector.on('message', function (nodeId, name, args, seq) {
        done();
      });

      receive[0](null, packMessage(connector, 'anotherNode', 'aMessage', [1, 2, 3], 8));
      receive.shift();
    });

    it('should repoll service bus after message is received', function () {
      var originalCalls = sb.receiveSubscriptionMessage.callCount;
      receive[0](null, packMessage(connector, 'anotherNode', 'aMessage', [3, 1, 4], 8));
      receive.shift();

      sb.receiveSubscriptionMessage.callCount.should.equal(originalCalls + 1);
    });

    it('should not raise event and repoll on receive error', function (done) {
      var originalCalls = sb.receiveSubscriptionMessage.callCount;
      connector.on('message', function (nodeId, name, args, seq) {
        done(new Error('Should not be called')); 
      });

      receive[0](new Error('Fake error'), null);
      receive.shift();
      
      sb.receiveSubscriptionMessage.callCount.should.equal(originalCalls + 1);
      done();
    });

    it('should stop all receivers when stop callback fires', function (done) {
      connector.stop(function () {
        connector.receivesRunning.should.equal(0);
        done();
      });

      receive.forEach(function (receiveFunc) {
        receiveFunc(connector, 'someNode', 'someMessage', 'someArgs');
      });
    });
  });

  describe('when stopping', function () {
    var sb;
    var connector;
    var receive;

    beforeEach(function () {
      sb = {
        sendTopicMessage: sinon.spy(),
        receiveSubscriptionMessage: sinon.spy(function (topic, subscription, callback) {
          receive = callback;
        }),
        createSubscription: function (topic, sub, opts, cb) { cb(); },
        withFilter: sinon.spy()
      };

      makeConnector(sb, function (serviceBus, newConnector) {
        connector = newConnector;
        connector.start();
      });
    });

    it('should stop polling service bus', function (done) {
      connector.stop(function () {
        sb.receiveSubscriptionMessage.calledOnce.should.be.true;
        done();
      });

      receive(null, packMessage(connector, 'sourceNode', 'message', 'pending'));
    });

    it('should start polling again if started after being stopped', function (done) {
      connector.stop(function () {
        sb.receiveSubscriptionMessage.calledOnce.should.be.true;
        connector.start();
        sb.receiveSubscriptionMessage.calledTwice.should.be.true;
        done();
      });

      receive(null, packMessage(connector, 'sourceNode', 'message', 'pending'));
    });  
  });
});

function makeConnectorWithMockSB(callback) {
  var sb = {
    receiveSubscriptionMessage: sinon.spy(),
    sendTopicMessage: sinon.spy(),
    createSubscription: function (topic, sub, opts, cb) { cb(); },
    withFilter: function (filter) { return this; }
  };
  makeConnector(sb, callback);
}

function makeConnectorWithOptions(serviceBus, options, callback) {
  options.nodeId = options.nodeId || nodeId;
  options.topicName = options.topicName || topicName;
  options.serviceBusService = serviceBus;
  options.numReceives = 1;

  var connector = new ServiceBusConnector(options);
  callback(serviceBus, connector);

}

function makeConnectorNoOptions(serviceBus, callback) {
  var connector = new ServiceBusConnector({
    nodeId: nodeId,
    topic: topicName,
    subscription: subscriptionName,
    serviceBusService: serviceBus,
    numReceives: 1
  });

  callback(serviceBus, connector);
}

function makeConnector() {
  if (arguments.length === 2) {
    makeConnectorNoOptions.apply(null, arguments);
  } else if (arguments.length === 3) {
    makeConnectorWithOptions.apply(null, arguments);
  } else {
    throw new Error('Unknown makeConnector overload with ' + arguments.length + ' arguments');
  }
}

function packMessage(connector, sourceNode, message, args, sequenceNumber) {
  var packed = connector.packMessage(message, args);
  packed.brokerProperties.CorrelationId = sourceNode;
  packed.brokerProperties.SequenceNumber = sequenceNumber;
  return packed;
}
