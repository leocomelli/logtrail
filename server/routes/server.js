import init_server_context from "./init_server_context.js"

var message_format_regex = /({{{(\S+)}}})/g;
var message_format_object_field_regex = /{{{(\S+)\.}}}/g;

function getMessageTemplate(handlebar, msg_format, message_mapping) {
  //Append <a> tags for click to message format except for message field  
  var ng_click_template = handlebar.compile("<a class=\"ng-binding\" title=\"{{title}}\" ng-click=\"onClick('{{name_no_braces}}','{{name}}')\">{{name}}</a>",
    {
      knownHelpers: {
        log: false,
        lookup: false
      },
      knownHelpersOnly: true
    });
  var messageField = "{{{" + message_mapping + "}}}";
  var message_template = msg_format;

  var match = message_format_regex.exec(msg_format);
  while (match !== null) {
    if (match[0] !== messageField) {
      if (match[2].lastIndexOf('.') > -1) {
        var title = match[2].split(".").pop();
      }

      var context = {
        name: match[0],
        name_no_braces: match[2],
        title: title
      };
      var with_click = ng_click_template(context);
      message_template = message_template.replace(match[0], with_click);
    }
    match = message_format_regex.exec(msg_format);
  }
  return message_template; //<a class="ng-binding" ng-click="onClick('pid','{{pid}}')">{{pid}}</a> : {{syslog_message}}
}

function convertToClientFormat(selected_config, esResponse) {
  var clientResponse = [];
  var hits = esResponse.hits.hits;

  var handlebar = require('handlebars');
  var message_format = selected_config.fields.message_format;

  for (var i = 0; i < hits.length; i++) {
    var event = {};
    var source = hits[i]._source;

    if (message_format) {
      var msgFmt = message_format
      var fields = []
      var m;

      while (m = message_format_object_field_regex.exec(msgFmt)) {
        msgFmt = msgFmt.replace('{{{' + m[1] + '.}}}', '')
        fields.push(m[1])
      }

      for (var k = 0, len = fields.length; k < len; k++) {
        if (typeof source[fields[k]] === 'object') {
          var match = message_format_regex.exec(msgFmt)
          if (match !== null) {
            var fieldKeys = Object.keys(source[fields[k]])
            msgFmt += ' '
            for (var j = 0, lg = fieldKeys.length; j < lg; j++) {
              msgFmt += '{{{' + fields[k] + '.' + fieldKeys[j] + '}}} '
            }
            msgFmt += ' '
          }
        }
      }

      var message_template = getMessageTemplate(handlebar, msgFmt, selected_config.fields.mapping.message);
      var template = handlebar.compile(message_template, {
        knownHelpers: {
          log: false,
          lookup: false
        },
        knownHelpersOnly: true
      });
    }

    event.id = hits[i]._id;
    var get = require('lodash.get');
    event['timestamp'] = get(source, selected_config.fields.mapping['timestamp']);
    event['display_timestamp'] = get(source, selected_config.fields.mapping['display_timestamp']);
    event['hostname'] = get(source, selected_config.fields.mapping['hostname']);
    event['program'] = get(source, selected_config.fields.mapping['program']);

    //Calculate message color, if configured
    if (selected_config.color_mapping && selected_config.color_mapping.field) {
      var color_field_val = get(source, selected_config.color_mapping.field);
      var color = selected_config.color_mapping.mapping[color_field_val];
      if (color) {
        event['color'] = color;
      }
    }

    //Change the source['message'] to highlighter text if available
    if (hits[i].highlight) {
      var get = require('lodash.get');
      var set = require('lodash.set');
      var with_highlights = get(hits[i].highlight, [selected_config.fields.mapping['message'], 0]);
      set(source, selected_config.fields.mapping['message'], with_highlights);
      source[selected_config.fields.mapping['message']] = hits[i].highlight[selected_config.fields.mapping['message']][0];
    }
    var message = source[selected_config.fields.mapping['message']];
    //sanitize html
    var escape = require('lodash.escape');
    message = escape(message);
    //if highlight is present then replace pre and post tag with html
    if (hits[i].highlight) {
      message = message.replace(/logtrail.highlight.pre_tag/g, '<span class="highlight">')
      message = message.replace(/logtrail.highlight.post_tag/g, '</span>')
    }
    source[selected_config.fields.mapping['message']] = message;

    //If the user has specified a custom format for message field
    if (message_format) {
      event['message'] = template(source);
    } else {
      event['message'] = message;
    }
    clientResponse.push(event);
  }
  return clientResponse;
}


module.exports = function (server) {

  var context = {};
  init_server_context(server, context);

  //Search
  server.route({
    method: ['POST'],
    path: '/logtrail/search',
    handler: function (request, reply) {
      var config = context.config;
      const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');

      var index = request.payload.index;
      var selected_config = config.index_patterns[0];
      if (index) {
        for (var i = config.index_patterns.length - 1; i >= 0; i--) {
          if (config.index_patterns[i].es.default_index === index) {
            selected_config = config.index_patterns[i];
            break;
          }
        }
      }

      var searchText = request.payload.searchText;

      if (searchText == null || searchText.length === 0) {
        searchText = '*';
      }

      //Search Request bbody
      var searchRequest = {
        index: selected_config.es.default_index,
        size: selected_config.max_buckets,
        body: {
          sort: [{}],
          query: {
            bool: {
              must: {
                query_string: {
                  analyze_wildcard: true,
                  default_field: selected_config.fields.mapping['message'],
                  query: searchText
                }
              },
              filter: {
                bool: {
                  must: [
                  ],
                  must_not: [],
                }
              }
            }
          },
          highlight: {
            pre_tags: ["logtrail.highlight.pre_tag"],
            post_tags: ["logtrail.highlight.post_tag"],
            fields: {
            }
          }
        }
      };
      //Enable highlightng on message field
      searchRequest.body.highlight.fields[selected_config.fields.mapping['message']] = {
        number_of_fragments: 0
      };

      //By default Set sorting column to timestamp
      searchRequest.body.sort[0][selected_config.fields.mapping.timestamp] = { 'order': request.payload.order, 'unmapped_type': 'boolean' };

      //If hostname is present then term query.
      if (request.payload.hostname != null) {
        var termQuery = {
          term: {
          }
        };
        var hostnameField = selected_config.fields.mapping.hostname;
        if (selected_config.fields['hostname.keyword']) {
          hostnameField += '.keyword';
        }
        termQuery.term[hostnameField] = request.payload.hostname;
        searchRequest.body.query.bool.filter.bool.must.push(termQuery);
      }

      //If no time range is present get events based on default selected_config
      var timestamp = request.payload.timestamp;
      var rangeType = request.payload.rangeType;
      if (timestamp == null) {
        if (selected_config.default_time_range_in_days !== 0) {
          var moment = require('moment');
          timestamp = moment().subtract(
            selected_config.default_time_range_in_days, 'days').startOf('day').valueOf();
          rangeType = 'gte';
        }
      }

      //If timestamps are present set ranges
      if (timestamp != null) {
        var rangeQuery = {
          range: {

          }
        };
        var range = rangeQuery.range;
        range[selected_config.fields.mapping.timestamp] = {};
        range[selected_config.fields.mapping.timestamp][rangeType] = timestamp;
        range[selected_config.fields.mapping.timestamp].format = 'epoch_millis';
        searchRequest.body.query.bool.filter.bool.must.push(rangeQuery);
      }
      //console.log(JSON.stringify(searchRequest));
      callWithRequest(request, 'search', searchRequest).then(function (resp) {
        reply({
          ok: true,
          resp: convertToClientFormat(selected_config, resp)
        });
      }).catch(function (resp) {
        if (resp.isBoom) {
          reply(resp);
        } else {
          console.error("Error while executing search", resp);
          reply({
            ok: false,
            resp: resp
          });
        }
      });
    }
  });

  //Get All Systems
  server.route({
    method: ['POST'],
    path: '/logtrail/hosts',
    handler: function (request, reply) {
      var config = context.config;
      const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');
      var index = request.payload.index;
      var selected_config = config.index_patterns[0];
      if (index) {
        for (var i = config.index_patterns.length - 1; i >= 0; i--) {
          if (config.index_patterns[i].es.default_index === index) {
            selected_config = config.index_patterns[i];
            break;
          }
        }
      }

      var hostnameField = selected_config.fields.mapping.hostname;
      if (selected_config.fields['hostname.keyword']) {
        hostnameField += '.keyword';
      }
      var hostAggRequest = {
        index: selected_config.es.default_index,
        body: {
          size: 0,
          aggs: {
            hosts: {
              terms: {
                field: hostnameField,
                size: selected_config.max_hosts
              }
            }
          }
        }
      };

      callWithRequest(request, 'search', hostAggRequest).then(function (resp) {
        //console.log(JSON.stringify(resp));//.aggregations.hosts.buckets);
        reply({
          ok: true,
          resp: resp.aggregations.hosts.buckets
        });
      }).catch(function (resp) {
        if (resp.isBoom) {
          reply(resp);
        } else {
          console.error("Error while fetching hosts", resp);
          reply({
            ok: false,
            resp: resp
          });
        }
      });
    }
  });

  server.route({
    method: 'GET',
    path: '/logtrail/config',
    handler: function (request, reply) {
      reply({
        ok: true,
        config: context.config
      });
    }
  });
};