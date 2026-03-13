public class ProlibuService {
    private static Set<Id> proposalsInProgress = new Set<Id>();

    public static void createProposalLogic(String oppId) {
      try {
          // Verificar si ya se está procesando esta oportunidad
          if (proposalsInProgress.contains(oppId)) {
              return;  // Salir si ya se está procesando
          }
          
          // Añadir la oportunidad al set de propuestas en progreso
          proposalsInProgress.add(oppId);
          
          // Obtener la oportunidad junto con la Cuenta, Productos, Contacto principal, y el Owner relacionado
          Opportunity opp = [
              SELECT Id, Name, StageName, Amount, CloseDate, Account.Name, Lead_Prolibu__c, Proposal_Created__c, 
              Webhook_Updated__c, Owner.FirstName, Owner.LastName, Owner.Email, Owner.Phone,
              (SELECT Role, ContactId, Contact.FirstName, Contact.LastName, Contact.Email, Contact.Phone 
               FROM OpportunityContactRoles WHERE IsPrimary = true),
              (SELECT Product2.Name, Product2.ProductCode, Quantity, UnitPrice 
               FROM OpportunityLineItems)
              FROM Opportunity
              WHERE Id = :oppId
              LIMIT 1
          ];
          
          // Verificar si la etapa es "Cotizado" o "Proposal/Price Quote" y si la propuesta no fue creada previamente
          if ((opp.StageName != 'Cotizado' && opp.StageName != 'Proposal/Price Quote') || opp.Proposal_Created__c) {
              return;  // Salir si no está en la etapa correcta o ya se creó la propuesta
          }
          
          // Evitar enviar el callout si la actualización vino del webhook
          if (opp.Webhook_Updated__c) {
              return;
          }
          
          // Crear el cuerpo de la solicitud con la estructura personalizada
          String endpoint = 'https://coltugs.prolibu.com/v1/integration/saleforce';
          HttpRequest req = new HttpRequest();
          req.setEndpoint(endpoint);
          req.setMethod('POST');
          req.setHeader('Content-Type', 'application/json');
          req.setHeader('Authorization', 'Bearer 75f5d6d9-022b-49a5-95d6-830f4cf4da03');
          req.setHeader('Cache-Control', 'no-cache');
          req.setHeader('Content-Type', 'application/json');
          req.setHeader('User-Agent', 'PostmanRuntime/7.37.3');
          req.setHeader('Accept', '*/*');
          req.setHeader('Accept-Encoding', 'gzip, deflate, br');
          req.setHeader('Connection', 'keep-alive');
          
          Map<String, Object> payload = new Map<String, Object>();
          payload.put('uuid', opp.Id);
          
          // Verificar si hay un contacto en Lead_Prolibu__c y usarlo o crear un lead genérico
          Map<String, Object> lead = new Map<String, Object>();
          
          if (opp.Lead_Prolibu__c != null) {
              Contact relatedContact = [SELECT Id, FirstName, LastName, Email, Phone
                                        FROM Contact
                                        WHERE Id = :opp.Lead_Prolibu__c
                                        LIMIT 1];
              lead.put('firstName', relatedContact.FirstName != null ? relatedContact.FirstName : 'N/A');
              lead.put('lastName', relatedContact.LastName != null ? relatedContact.LastName : 'N/A');
              lead.put('email', relatedContact.Email != null && relatedContact.Email.contains('@') ? relatedContact.Email : 'invalid-email@example.com');
          } else {
              // Lead genérico si no hay contacto en Lead_Prolibu__c
              lead.put('firstName', 'Generic');
              lead.put('lastName', 'Lead');
              lead.put('email', 'generic-lead@example.com');
          }
          
          // Añadir el nombre de la compañía
          lead.put('companyName', opp.AccountId != null ? opp.Account.Name : 'N/A');
          payload.put('lead', lead);
          
          Map<String, Object> agent = new Map<String, Object>();
          agent.put('firstName', opp.Owner.FirstName != null ? opp.Owner.FirstName : 'N/A');
          agent.put('lastName', opp.Owner.LastName != null ? opp.Owner.LastName : 'N/A');
          agent.put('email', opp.Owner.Email != null && opp.Owner.Email.contains('@') ? opp.Owner.Email : 'invalid-agent-email@example.com');
          payload.put('agent', agent);
          
          Map<String, Object> data = new Map<String, Object>();
          data.put('title', opp.Name);
            Datetime localDatetime = opp.CloseDate; // Fecha dinámica obtenida de Salesforce
            TimeZone tz = UserInfo.getTimeZone(); // Obtiene la zona horaria del usuario actual
            
            // Calcula la diferencia en segundos entre UTC y la zona horaria local
            Integer offsetSeconds = tz.getOffset(localDatetime) / 1000;
            
            // Ajusta la fecha local a UTC
            Datetime utcDatetime = localDatetime.addSeconds(-offsetSeconds);
            
          data.put('expectedCloseDate', utcDatetime);
          List<Map<String, Object>> products = new List<Map<String, Object>>();
          for (OpportunityLineItem item : opp.OpportunityLineItems) {
              Map<String, Object> productInfo = new Map<String, Object>();
              productInfo.put('name', item.Product2.Name);
              productInfo.put('sku', item.Product2.ProductCode);
              productInfo.put('quantity', item.Quantity);
              productInfo.put('price', item.UnitPrice);
              products.add(productInfo);
          }
          data.put('products', products);
          payload.put('data', data);
          
          req.setBody(JSON.serialize(payload));
          Http http = new Http();
          HttpResponse res = http.send(req);
          
          Map<String, Object> responseBody = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
          String responseUrl = (String) responseBody.get('anonymousUrl');
          
          Opportunity oppToUpdate = new Opportunity(Id = opp.Id);
          oppToUpdate.Propuesta_Prolibu__c = responseUrl;
          oppToUpdate.Proposal_Created__c = true;  // Marcar la propuesta como creada
          oppToUpdate.Webhook_Updated__c = false;  // Desmarcar el campo, ya que la actualización no provino del webhook
          
          // Actualizar la oportunidad
          Savepoint sp = Database.setSavepoint();
          try {
              update oppToUpdate;
          } catch (DmlException dmlEx) {
              Database.rollback(sp);
          }
        } catch (Exception e) {
         System.debug('Excepción al enviar la propuesta al endpoint real: ' + e.getMessage());
      } finally {
         proposalsInProgress.remove(oppId);
      }
    }
    
    public static void changeOpportunityStatusLogic(String oppId, String status, String lossReason) {
      try {
            // Endpoint con el ID de la oportunidad y el nuevo estado
            String endpoint = 'https://coltugs.prolibu.com/v1/integration/saleforce/changeStatus/' + oppId + '/' + status;
            
            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('PUT');
            req.setHeader('Content-Type', 'application/json');
            
            // Agregar el token Bearer para la autorización
            String bearerToken = '75f5d6d9-022b-49a5-95d6-830f4cf4da03';
            req.setHeader('Authorization', 'Bearer ' + bearerToken);
            
            // Crear el cuerpo de la solicitud con el motivo de pérdida si está disponible
            Map<String, Object> requestBody = new Map<String, Object>();
            requestBody.put('status', status);
            
            if (lossReason != null && lossReason != '') {
                requestBody.put('lossReason', lossReason);
            }
            
            // Establecer el cuerpo de la solicitud
            req.setBody(JSON.serialize(requestBody));
            
            Http http = new Http();
            HttpResponse res = http.send(req);
            
            if (res.getStatusCode() == 200) {
                System.debug('Cambio de estado enviado con éxito: ' + status);
            } else {
                System.debug('Error al cambiar el estado: ' + res.getBody());
            }
        } catch (Exception e) {
        System.debug('Excepción al cambiar el estado: ' + e.getMessage());
      }
    }

    public static void updateProposalLogic(String oppId){
                try {
            // Obtener la oportunidad junto con la Cuenta, Productos, Contacto principal, el Owner relacionado y el campo Lead_Prolibu__c
            Opportunity opp = [
                SELECT Id, Name, Amount, CloseDate, Account.Name, Lead_Prolibu__c, Webhook_Updated__c,
                       Owner.FirstName, Owner.LastName, Owner.Email, Owner.Phone,
                       (SELECT Role, ContactId, Contact.FirstName, Contact.LastName, Contact.Email, Contact.Phone 
                        FROM OpportunityContactRoles WHERE IsPrimary = true),
                       (SELECT Product2.Name, Product2.ProductCode, Quantity, UnitPrice 
                        FROM OpportunityLineItems)
                FROM Opportunity
                WHERE Id = :oppId
                LIMIT 1
            ];
    
            // Verificar si la oportunidad fue actualizada por el webhook
            if (opp.Webhook_Updated__c) {
                return;
            }
    
            // Crear el cuerpo de la solicitud con la estructura personalizada
            String endpoint = 'https://coltugs.prolibu.com/v1/integration/saleforce/' + oppId;
            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('PUT'); // Método PUT para actualizar
            req.setHeader('Content-Type', 'application/json');
            String bearerToken = '75f5d6d9-022b-49a5-95d6-830f4cf4da03';
            req.setHeader('Authorization', 'Bearer ' + bearerToken);
    
            // Crear el payload
            Map<String, Object> payload = new Map<String, Object>();
            payload.put('uuid', opp.Id);
    
            // Lead (Información del Lead relacionado, si existe)
            Contact relatedLead;
            if (opp.Lead_Prolibu__c != null) {
                relatedLead = [SELECT Id, FirstName, LastName, Email, Phone FROM Contact WHERE Id = :opp.Lead_Prolibu__c LIMIT 1];
                Map<String, Object> lead = new Map<String, Object>();
                lead.put('firstName', relatedLead.FirstName != null ? relatedLead.FirstName : 'N/A');
                lead.put('lastName', relatedLead.LastName != null ? relatedLead.LastName : 'N/A');
                lead.put('email', relatedLead.Email != null && relatedLead.Email.contains('@') ? relatedLead.Email : 'invalid-email@example.com');
                payload.put('lead', lead);
            }
    
            // Agent (Información del propietario de la oportunidad)
            Map<String, Object> agent = new Map<String, Object>();
            agent.put('firstName', opp.Owner.FirstName != null ? opp.Owner.FirstName : 'N/A');
            agent.put('lastName', opp.Owner.LastName != null ? opp.Owner.LastName : 'N/A');
            agent.put('email', opp.Owner.Email != null && opp.Owner.Email.contains('@') ? opp.Owner.Email : 'invalid-agent-email@example.com');
            payload.put('agent', agent);
    
            // Data (Información de la oportunidad y productos)
            Map<String, Object> data = new Map<String, Object>();
            data.put('title', opp.Name);
    
            Datetime localDatetime = opp.CloseDate; // Fecha dinámica obtenida de Salesforce
            TimeZone tz = UserInfo.getTimeZone(); // Obtiene la zona horaria del usuario actual
            
            // Calcula la diferencia en segundos entre UTC y la zona horaria local
            Integer offsetSeconds = tz.getOffset(localDatetime) / 1000;
            
            // Ajusta la fecha local a UTC
            Datetime utcDatetime = localDatetime.addSeconds(-offsetSeconds);

            data.put('expectedCloseDate', utcDatetime);  // Fecha de cierre como la fecha de expiración
    
            // Lista de productos
            List<Map<String, Object>> products = new List<Map<String, Object>>();
            if (opp.OpportunityLineItems != null && opp.OpportunityLineItems.size() > 0) {
                for (OpportunityLineItem item : opp.OpportunityLineItems) {
                    Map<String, Object> productInfo = new Map<String, Object>();
                    productInfo.put('name', item.Product2.Name);
                    productInfo.put('sku', item.Product2.ProductCode);  // Código del producto
                    productInfo.put('quantity', item.Quantity);
                    productInfo.put('price', item.UnitPrice);
    
                    products.add(productInfo);
                }
            }
            data.put('products', products);
            payload.put('data', data);
    
            // Establecer el cuerpo de la solicitud
            req.setBody(JSON.serialize(payload));
    
            // Enviar la solicitud HTTP
            Http http = new Http();
            HttpResponse res = http.send(req);
    
            // Verificar la respuesta
            if (res.getStatusCode() == 200) {
                System.debug('Propuesta actualizada con éxito en el endpoint real.');
            } else {
                System.debug('Error al actualizar la propuesta en el endpoint real: ' + res.getBody());
            }
        } catch (Exception e) {
            System.debug('Excepción al actualizar la propuesta: ' + e.getMessage());
        }
    }


    public static void sendDenialReasonLogic(String oppId, String denialReason){
        try {
            // Construir el endpoint con el ID de la oportunidad
            String endpoint = 'https://coltugs.prolibu.com/v1/integration/saleforce/denialReason/' + oppId + '/' + EncodingUtil.urlEncode(denialReason, 'UTF-8');
            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('PUT');
            req.setHeader('Content-Type', 'application/json');
            
            // Agregar el token Bearer para la autorización
            String bearerToken = '75f5d6d9-022b-49a5-95d6-830f4cf4da03';
            req.setHeader('Authorization', 'Bearer ' + bearerToken);
            
            Http http = new Http();
            HttpResponse res = http.send(req);
            
            if (res.getStatusCode() == 200) {
                System.debug('Motivo de denegación enviado con éxito para la oportunidad: ' + oppId);
            } else {
                System.debug('Error al enviar el motivo de denegación: ' + res.getBody());
            }
        } catch (Exception e) {
            System.debug('Excepción al enviar el motivo de denegación: ' + e.getMessage());
        }
    }

}
